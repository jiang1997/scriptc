/* X509Certificate fields (raw, subject, issuer, subjectAltName,
 * infoAccess, serialNumber, fingerprint256, fingerprint512, ca,
 * signatureAlgorithm, signatureAlgorithmOid), linked only into programs
 * that read them (the x509 runtime feature). */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Copies of scr_lib.c's PEM front half and DER header reader for the
 * X509Certificate members it keeps, so that unit is unchanged for
 * programs that do not read these fields. */

/* PEM armor → DER (or raw-DER passthrough), the shared front half of
 * every X509Certificate member. On success `*der`/`*der_len` hold the
 * certificate bytes and `*decoded` the malloc'd base64 buffer to free
 * (NULL for raw-DER input); unparseable input throws Node's exact PEM
 * error and answers false with the exception pending. */
static bool scr_x509_der(const uint8_t *in, size_t n, const uint8_t **der, size_t *der_len,
                          uint8_t **decoded) {
  static const char begin[] = "-----BEGIN CERTIFICATE-----";
  static const char end[] = "-----END CERTIFICATE-----";
  *der = NULL;
  *der_len = 0;
  *decoded = NULL;
  /* PEM: base64-decode the armor's body. */
  const uint8_t *b = NULL;
  for (size_t i = 0; i + sizeof begin - 1 <= n; i++) {
    if (memcmp(in + i, begin, sizeof begin - 1) == 0) {
      b = in + i + sizeof begin - 1;
      break;
    }
  }
  if (b != NULL) {
    const uint8_t *stop = in + n;
    for (const uint8_t *p = b; p + sizeof end - 1 <= in + n; p++) {
      if (memcmp(p, end, sizeof end - 1) == 0) {
        stop = p;
        break;
      }
    }
    uint8_t *out = malloc(((size_t)(stop - b) / 4 + 1) * 3 + 3);
    if (!out) {
      scr_trap("scriptc: out of memory\n");
    }
    size_t o = 0;
    unsigned acc = 0;
    int have = 0;
    for (const uint8_t *p = b; p < stop; p++) {
      int v;
      uint8_t c = *p;
      if (c >= 'A' && c <= 'Z') v = c - 'A';
      else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
      else if (c >= '0' && c <= '9') v = c - '0' + 52;
      else if (c == '+') v = 62;
      else if (c == '/') v = 63;
      else continue; /* whitespace, '=' */
      acc = (acc << 6) | (unsigned)v;
      if (++have == 4) {
        out[o++] = (uint8_t)(acc >> 16);
        out[o++] = (uint8_t)(acc >> 8);
        out[o++] = (uint8_t)acc;
        acc = 0;
        have = 0;
      }
    }
    if (have == 2) out[o++] = (uint8_t)(acc >> 4);
    else if (have == 3) {
      out[o++] = (uint8_t)(acc >> 10);
      out[o++] = (uint8_t)(acc >> 2);
    }
    *decoded = out;
    *der = out;
    *der_len = o;
    return true;
  }
  if (n > 0 && in[0] == 0x30) {
    /* Raw DER: the certificate SEQUENCE. */
    *der = in;
    *der_len = n;
    return true;
  }
  scr_throw_error_msg_code(SCR_ERR_ERROR,
                            "error:0480006C:PEM routines::no start line",
                            42, "ERR_OSSL_PEM_NO_START_LINE");
  return false; /* exception pending */
}

/* Reads one DER TL header at p (before end): tag to *tag, content length
 * to *len, and answers the content pointer (NULL on malformed/overlong). */
static const uint8_t *scr_der_tl(const uint8_t *p, const uint8_t *end, uint8_t *tag, size_t *len) {
  if (p == NULL || end - p < 2) return NULL;
  *tag = p[0];
  uint8_t l0 = p[1];
  const uint8_t *content = p + 2;
  size_t l;
  if (l0 < 0x80) {
    l = l0;
  } else {
    size_t nb = l0 & 0x7f;
    if (nb == 0 || nb > sizeof(size_t) || end - content < (ptrdiff_t)nb) return NULL;
    l = 0;
    for (size_t i = 0; i < nb; i++) l = (l << 8) | content[i];
    content += nb;
  }
  if ((size_t)(end - content) < l) return NULL;
  *tag = p[0];
  *len = l;
  return content;
}

/* ── X509Certificate fields over the DER ─────────────────────────────────
 *
 * `raw` decodes the constructor's input once (scr_x509_der); every other
 * field reads those DER bytes. The walks follow RFC 5280's Certificate ::=
 * SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue } and
 * render each value as Node does: names through X509_NAME_print_ex (one
 * attribute per line, RFC 2253 escaping), alternative names and access
 * descriptions through Node's PrintGeneralName, the serial number through
 * BN_bn2hex. A field whose part of the certificate is missing or malformed
 * answers Node's value for an absent part. */

typedef struct {
  char *data;
  size_t len, cap;
} ScrX509Buf;

static void scr_x509_put(ScrX509Buf *b, const void *p, size_t n) {
  if (b->len + n > b->cap) {
    size_t cap = b->cap ? b->cap * 2 : 128;
    while (cap < b->len + n) cap *= 2;
    char *grown = realloc(b->data, cap);
    if (!grown) scr_trap("scriptc: out of memory\n");
    b->data = grown;
    b->cap = cap;
  }
  memcpy(b->data + b->len, p, n);
  b->len += n;
}

static void scr_x509_puts(ScrX509Buf *b, const char *s) { scr_x509_put(b, s, strlen(s)); }

static void scr_x509_putc(ScrX509Buf *b, char c) { scr_x509_put(b, &c, 1); }

static ScrStr *scr_x509_buf_str(ScrX509Buf *b) {
  ScrStr *s = scr_str_new(b->data ? b->data : "", b->len);
  free(b->data);
  return s;
}

/* The DER of a certificate field's input (raw or the bytes constructor
 * input). */
#define SCR_X509_DER(bytes) \
  ((const uint8_t *)(bytes)->data), ((bytes)->len * scr_bytes_elem_size((bytes)->elem))

typedef struct {
  const uint8_t *tbs, *tbs_end; /* tbsCertificate contents */
  const uint8_t *sig_alg;       /* outer signatureAlgorithm contents */
  size_t sig_alg_len;
  const uint8_t *serial;        /* serialNumber contents */
  size_t serial_len;
  const uint8_t *issuer, *subject; /* Name contents */
  size_t issuer_len, subject_len;
  const uint8_t *validity;      /* Validity contents */
  size_t validity_len;
  const uint8_t *exts;          /* Extensions SEQUENCE contents, or NULL */
  size_t exts_len;
} ScrX509Parts;

/* Splits the certificate into the parts the fields read; false when the
 * outer structure does not parse. */
static bool scr_x509_parts(const uint8_t *der, size_t n, ScrX509Parts *out) {
  memset(out, 0, sizeof *out);
  const uint8_t *end = der + n;
  uint8_t tag;
  size_t len;
  const uint8_t *cert = scr_der_tl(der, end, &tag, &len);
  if (!cert || tag != 0x30) return false;
  const uint8_t *cert_end = cert + len;
  const uint8_t *tbs = scr_der_tl(cert, cert_end, &tag, &len);
  if (!tbs || tag != 0x30) return false;
  out->tbs = tbs;
  out->tbs_end = tbs + len;
  const uint8_t *alg = scr_der_tl(tbs + len, cert_end, &tag, &len);
  if (alg && tag == 0x30) {
    out->sig_alg = alg;
    out->sig_alg_len = len;
  }
  const uint8_t *p = tbs;
  const uint8_t *c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (c && tag == 0xA0) { /* [0] version */
    p = c + len;
    c = scr_der_tl(p, out->tbs_end, &tag, &len);
  }
  if (!c || tag != 0x02) return true;
  out->serial = c;
  out->serial_len = len;
  p = c + len;
  /* signature AlgorithmIdentifier */
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (!c) return true;
  p = c + len;
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (!c || tag != 0x30) return true;
  out->issuer = c;
  out->issuer_len = len;
  p = c + len;
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (!c || tag != 0x30) return true;
  out->validity = c;
  out->validity_len = len;
  p = c + len;
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (!c || tag != 0x30) return true;
  out->subject = c;
  out->subject_len = len;
  p = c + len;
  /* subjectPublicKeyInfo, then the optional [1] [2] unique IDs and [3]
   * extensions */
  while (p < out->tbs_end) {
    c = scr_der_tl(p, out->tbs_end, &tag, &len);
    if (!c) break;
    if (tag == 0xA3) {
      const uint8_t *seq = scr_der_tl(c, c + len, &tag, &len);
      if (seq && tag == 0x30) {
        out->exts = seq;
        out->exts_len = len;
      }
      break;
    }
    p = c + len;
  }
  return true;
}

/* Finds the extension with the DER-encoded OID `oid` (contents only):
 * its extnValue contents, or NULL. */
static const uint8_t *scr_x509_ext(const ScrX509Parts *parts, const uint8_t *oid, size_t oid_len,
                                   size_t *value_len) {
  if (!parts->exts) return NULL;
  const uint8_t *p = parts->exts;
  const uint8_t *end = parts->exts + parts->exts_len;
  uint8_t tag;
  size_t len;
  while (p < end) {
    const uint8_t *ext = scr_der_tl(p, end, &tag, &len);
    if (!ext || tag != 0x30) return NULL;
    const uint8_t *ext_end = ext + len;
    p = ext_end;
    const uint8_t *id = scr_der_tl(ext, ext_end, &tag, &len);
    if (!id || tag != 0x06) continue;
    bool match = len == oid_len && memcmp(id, oid, len) == 0;
    const uint8_t *q = id + len;
    const uint8_t *v = scr_der_tl(q, ext_end, &tag, &len);
    if (v && tag == 0x01) { /* critical */
      q = v + len;
      v = scr_der_tl(q, ext_end, &tag, &len);
    }
    if (match && v && tag == 0x04) {
      *value_len = len;
      return v;
    }
  }
  return NULL;
}

/* An OID's dotted text (OBJ_obj2txt with no_name). */
static void scr_x509_oid_dotted(ScrX509Buf *b, const uint8_t *oid, size_t n) {
  char tmp[24];
  uint64_t v = 0;
  bool first = true;
  for (size_t i = 0; i < n; i++) {
    v = (v << 7) | (oid[i] & 0x7f);
    if (oid[i] & 0x80) continue;
    if (first) {
      unsigned top = v < 40 ? 0 : v < 80 ? 1 : 2;
      snprintf(tmp, sizeof tmp, "%u.%llu", top, (unsigned long long)(v - top * 40));
      first = false;
    } else {
      snprintf(tmp, sizeof tmp, ".%llu", (unsigned long long)v);
    }
    scr_x509_puts(b, tmp);
    v = 0;
  }
}

typedef struct {
  const char *oid; /* dotted */
  const char *name;
} ScrX509OidName;

/* OpenSSL's short names for the attribute types names use (XN_FLAG_FN_SN). */
static const ScrX509OidName scr_x509_attr_names[] = {
    {"2.5.4.3", "CN"},
    {"2.5.4.4", "SN"},
    {"2.5.4.5", "serialNumber"},
    {"2.5.4.6", "C"},
    {"2.5.4.7", "L"},
    {"2.5.4.8", "ST"},
    {"2.5.4.9", "street"},
    {"2.5.4.10", "O"},
    {"2.5.4.11", "OU"},
    {"2.5.4.12", "title"},
    {"2.5.4.13", "description"},
    {"2.5.4.15", "businessCategory"},
    {"2.5.4.16", "postalAddress"},
    {"2.5.4.17", "postalCode"},
    {"2.5.4.18", "postOfficeBox"},
    {"2.5.4.20", "telephoneNumber"},
    {"2.5.4.41", "name"},
    {"2.5.4.42", "GN"},
    {"2.5.4.43", "initials"},
    {"2.5.4.44", "generationQualifier"},
    {"2.5.4.45", "x500UniqueIdentifier"},
    {"2.5.4.46", "dnQualifier"},
    {"2.5.4.65", "pseudonym"},
    {"2.5.4.72", "role"},
    {"2.5.4.97", "organizationIdentifier"},
    {"1.2.840.113549.1.9.1", "emailAddress"},
    {"1.2.840.113549.1.9.2", "unstructuredName"},
    {"0.9.2342.19200300.100.1.1", "UID"},
    {"0.9.2342.19200300.100.1.25", "DC"},
    {"1.3.6.1.4.1.311.60.2.1.1", "jurisdictionL"},
    {"1.3.6.1.4.1.311.60.2.1.2", "jurisdictionST"},
    {"1.3.6.1.4.1.311.60.2.1.3", "jurisdictionC"},
};

/* OpenSSL's long names for the signature algorithms certificates use. */
static const ScrX509OidName scr_x509_sig_names[] = {
    {"1.2.840.113549.1.1.4", "md5WithRSAEncryption"},
    {"1.2.840.113549.1.1.5", "sha1WithRSAEncryption"},
    {"1.2.840.113549.1.1.10", "rsassaPss"},
    {"1.2.840.113549.1.1.11", "sha256WithRSAEncryption"},
    {"1.2.840.113549.1.1.12", "sha384WithRSAEncryption"},
    {"1.2.840.113549.1.1.13", "sha512WithRSAEncryption"},
    {"1.2.840.113549.1.1.14", "sha224WithRSAEncryption"},
    {"1.2.840.10045.4.1", "ecdsa-with-SHA1"},
    {"1.2.840.10045.4.3.1", "ecdsa-with-SHA224"},
    {"1.2.840.10045.4.3.2", "ecdsa-with-SHA256"},
    {"1.2.840.10045.4.3.3", "ecdsa-with-SHA384"},
    {"1.2.840.10045.4.3.4", "ecdsa-with-SHA512"},
    {"1.2.840.10040.4.3", "dsaWithSHA1"},
    {"2.16.840.1.101.3.4.3.1", "dsa_with_SHA224"},
    {"2.16.840.1.101.3.4.3.2", "dsa_with_SHA256"},
    {"1.3.101.112", "ED25519"},
    {"1.3.101.113", "ED448"},
};

/* OpenSSL's long names for the access methods infoAccess prints. */
static const ScrX509OidName scr_x509_access_names[] = {
    {"1.3.6.1.5.5.7.48.1", "OCSP"},
    {"1.3.6.1.5.5.7.48.2", "CA Issuers"},
    {"1.3.6.1.5.5.7.48.3", "AD Time Stamping"},
    {"1.3.6.1.5.5.7.48.5", "CA Repository"},
};

/* Appends the table name of an OID, or its dotted text; answers whether
 * the table named it. */
static bool scr_x509_oid_name(ScrX509Buf *b, const uint8_t *oid, size_t n,
                              const ScrX509OidName *table, size_t count) {
  ScrX509Buf dotted = {0};
  scr_x509_oid_dotted(&dotted, oid, n);
  for (size_t i = 0; i < count; i++) {
    if (strlen(table[i].oid) == dotted.len && memcmp(table[i].oid, dotted.data, dotted.len) == 0) {
      scr_x509_puts(b, table[i].name);
      free(dotted.data);
      return true;
    }
  }
  scr_x509_put(b, dotted.data, dotted.len);
  free(dotted.data);
  return false;
}

/* Appends one code point as UTF-8. */
static void scr_x509_put_utf8(ScrX509Buf *b, uint32_t c) {
  char u[4];
  size_t n;
  if (c < 0x80) {
    u[0] = (char)c;
    n = 1;
  } else if (c < 0x800) {
    u[0] = (char)(0xC0 | (c >> 6));
    u[1] = (char)(0x80 | (c & 0x3F));
    n = 2;
  } else if (c < 0x10000) {
    u[0] = (char)(0xE0 | (c >> 12));
    u[1] = (char)(0x80 | ((c >> 6) & 0x3F));
    u[2] = (char)(0x80 | (c & 0x3F));
    n = 3;
  } else {
    u[0] = (char)(0xF0 | (c >> 18));
    u[1] = (char)(0x80 | ((c >> 12) & 0x3F));
    u[2] = (char)(0x80 | ((c >> 6) & 0x3F));
    u[3] = (char)(0x80 | (c & 0x3F));
    n = 4;
  }
  scr_x509_put(b, u, n);
}

/* An attribute value as UTF-8 bytes (ASN1_STRFLGS_UTF8_CONVERT): a
 * UTF8String as stored, BMPString and UniversalString decoded, every other
 * type read as Latin-1. */
static void scr_x509_value_utf8(ScrX509Buf *out, uint8_t tag, const uint8_t *v, size_t n) {
  if (tag == 0x0C) {
    scr_x509_put(out, v, n);
  } else if (tag == 0x1E) {
    for (size_t i = 0; i + 1 < n; i += 2) scr_x509_put_utf8(out, ((uint32_t)v[i] << 8) | v[i + 1]);
  } else if (tag == 0x1C) {
    for (size_t i = 0; i + 3 < n; i += 4)
      scr_x509_put_utf8(out, ((uint32_t)v[i] << 24) | ((uint32_t)v[i + 1] << 16) |
                                 ((uint32_t)v[i + 2] << 8) | v[i + 3]);
  } else {
    for (size_t i = 0; i < n; i++) scr_x509_put_utf8(out, v[i]);
  }
}

/* Appends a value with ASN1_STRFLGS_ESC_2253 escaping: the characters
 * `"+,;<>\` get a backslash, as do a leading '#' or space and a trailing
 * space; with `esc_ctrl`, control characters print as \XX. Bytes above
 * 0x7f pass through. */
static void scr_x509_put_escaped(ScrX509Buf *b, const uint8_t *s, size_t n, bool esc_ctrl) {
  static const char hex[] = "0123456789ABCDEF";
  for (size_t i = 0; i < n; i++) {
    uint8_t c = s[i];
    bool first = i == 0;
    bool last = i + 1 == n;
    if (c == '"' || c == '+' || c == ',' || c == ';' || c == '<' || c == '>' || c == '\\' ||
        (first && (c == '#' || c == ' ')) || (last && c == ' ')) {
      scr_x509_putc(b, '\\');
      scr_x509_putc(b, (char)c);
    } else if (esc_ctrl && (c < 0x20 || c == 0x7f)) {
      char e[3] = {'\\', hex[c >> 4], hex[c & 0x0f]};
      scr_x509_put(b, e, 3);
    } else {
      scr_x509_putc(b, (char)c);
    }
  }
}

/* Prints a Name. `multiline` is Node's subject/issuer form (attributes in
 * order, one RDN per line, ESC_CTRL); otherwise the RFC 2253 form DirName
 * alternative names use (RDNs reversed and comma-separated, unknown
 * attribute types dumped as #hex of the value's DER). RDNs with several
 * attributes join them with " + " or "+". */
static void scr_x509_name_print(ScrX509Buf *b, const uint8_t *name, size_t n, bool multiline) {
  const uint8_t *end = name + n;
  const uint8_t *rdns[64];
  size_t rdn_lens[64];
  size_t count = 0;
  uint8_t tag;
  size_t len;
  for (const uint8_t *p = name; p < end && count < 64;) {
    const uint8_t *set = scr_der_tl(p, end, &tag, &len);
    if (!set || tag != 0x31) break;
    rdns[count] = set;
    rdn_lens[count++] = len;
    p = set + len;
  }
  for (size_t k = 0; k < count; k++) {
    size_t r = multiline ? k : count - 1 - k;
    if (k > 0) scr_x509_puts(b, multiline ? "\n" : ",");
    const uint8_t *set_end = rdns[r] + rdn_lens[r];
    bool first_attr = true;
    for (const uint8_t *q = rdns[r]; q < set_end;) {
      const uint8_t *atv = scr_der_tl(q, set_end, &tag, &len);
      if (!atv || tag != 0x30) break;
      const uint8_t *atv_end = atv + len;
      q = atv_end;
      const uint8_t *oid = scr_der_tl(atv, atv_end, &tag, &len);
      if (!oid || tag != 0x06) continue;
      size_t oid_len = len;
      const uint8_t *value_tl = oid + len;
      uint8_t vtag;
      size_t vlen;
      const uint8_t *value = scr_der_tl(value_tl, atv_end, &vtag, &vlen);
      if (!value) continue;
      if (!first_attr) scr_x509_puts(b, multiline ? " + " : "+");
      first_attr = false;
      bool known = scr_x509_oid_name(b, oid, oid_len, scr_x509_attr_names,
                                     sizeof scr_x509_attr_names / sizeof scr_x509_attr_names[0]);
      scr_x509_putc(b, '=');
      if (!multiline && !known) {
        static const char hex[] = "0123456789ABCDEF";
        scr_x509_putc(b, '#');
        for (const uint8_t *d = value_tl; d < value + vlen; d++) {
          scr_x509_putc(b, hex[*d >> 4]);
          scr_x509_putc(b, hex[*d & 0x0f]);
        }
        continue;
      }
      ScrX509Buf text = {0};
      scr_x509_value_utf8(&text, vtag, value, vlen);
      scr_x509_put_escaped(b, (const uint8_t *)text.data, text.len, multiline);
      free(text.data);
    }
  }
}

/* Node's PrintAltName: a name with none of `"\,'` and only printable
 * characters (in UTF-8 names, only non-control bytes) prints as is;
 * otherwise it prints as a JSON string, `prefix:` inside the quotes, with
 * `\\`, `\"` and \u00XX for commas, control characters and (outside
 * UTF-8 names) bytes above 0x7e. */
static void scr_x509_put_alt_name(ScrX509Buf *b, const uint8_t *s, size_t n, bool utf8,
                                  const char *prefix) {
  bool safe = true;
  for (size_t i = 0; i < n && safe; i++) {
    uint8_t c = s[i];
    if (c == '"' || c == '\\' || c == ',' || c == '\'') safe = false;
    else if (utf8 ? (c < ' ' || c == 0x7f) : (c < ' ' || c > '~')) safe = false;
  }
  if (safe) {
    if (prefix) {
      scr_x509_puts(b, prefix);
      scr_x509_putc(b, ':');
    }
    scr_x509_put(b, s, n);
    return;
  }
  static const char hex[] = "0123456789abcdef";
  scr_x509_putc(b, '"');
  if (prefix) {
    scr_x509_puts(b, prefix);
    scr_x509_putc(b, ':');
  }
  for (size_t i = 0; i < n; i++) {
    uint8_t c = s[i];
    if (c == '\\') {
      scr_x509_puts(b, "\\\\");
    } else if (c == '"') {
      scr_x509_puts(b, "\\\"");
    } else if ((c >= ' ' && c != ',' && c <= '~') || (utf8 && (c & 0x80))) {
      scr_x509_putc(b, (char)c);
    } else {
      char u[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 0x0f]};
      scr_x509_put(b, u, 6);
    }
  }
  scr_x509_putc(b, '"');
}

static const uint8_t SCR_X509_OID_UPN[] = {0x2B, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x14, 0x02, 0x03};
static const uint8_t SCR_X509_OID_XMPP[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x05};
static const uint8_t SCR_X509_OID_SRV[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x07};
static const uint8_t SCR_X509_OID_NAI[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x08};
static const uint8_t SCR_X509_OID_SMTP_UTF8[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x09};

/* Node's PrintGeneralName for one GeneralName element (tag and contents). */
static void scr_x509_general_name(ScrX509Buf *b, uint8_t tag, const uint8_t *v, size_t n) {
  switch (tag) {
    case 0x81: /* rfc822Name */
      scr_x509_puts(b, "email:");
      scr_x509_put_alt_name(b, v, n, false, NULL);
      return;
    case 0x82: /* dNSName */
      scr_x509_puts(b, "DNS:");
      scr_x509_put_alt_name(b, v, n, false, NULL);
      return;
    case 0x86: /* uniformResourceIdentifier */
      scr_x509_puts(b, "URI:");
      scr_x509_put_alt_name(b, v, n, false, NULL);
      return;
    case 0x87: { /* iPAddress */
      char tmp[48];
      scr_x509_puts(b, "IP Address:");
      if (n == 4) {
        snprintf(tmp, sizeof tmp, "%d.%d.%d.%d", v[0], v[1], v[2], v[3]);
        scr_x509_puts(b, tmp);
      } else if (n == 16) {
        for (unsigned j = 0; j < 8; j++) {
          snprintf(tmp, sizeof tmp, j == 0 ? "%X" : ":%X", (unsigned)((v[2 * j] << 8) | v[2 * j + 1]));
          scr_x509_puts(b, tmp);
        }
      } else {
        snprintf(tmp, sizeof tmp, "<invalid length=%zu>", n);
        scr_x509_puts(b, tmp);
      }
      return;
    }
    case 0x88: /* registeredID */
      scr_x509_puts(b, "Registered ID:");
      scr_x509_oid_dotted(b, v, n);
      return;
    case 0xA4: { /* directoryName: [4] EXPLICIT Name */
      uint8_t ntag;
      size_t nlen;
      const uint8_t *name = scr_der_tl(v, v + n, &ntag, &nlen);
      ScrX509Buf text = {0};
      if (name && ntag == 0x30) scr_x509_name_print(&text, name, nlen, false);
      scr_x509_puts(b, "DirName:");
      scr_x509_put_alt_name(b, (const uint8_t *)(text.data ? text.data : ""), text.len, true, NULL);
      free(text.data);
      return;
    }
    case 0xA0: { /* otherName: type-id OID, [0] EXPLICIT value */
      uint8_t t;
      size_t len;
      const uint8_t *end = v + n;
      const uint8_t *oid = scr_der_tl(v, end, &t, &len);
      const char *prefix = NULL;
      bool unicode = true;
      if (oid && t == 0x06) {
#define SCR_X509_OID_IS(o) (len == sizeof(o) && memcmp(oid, (o), sizeof(o)) == 0)
        if (SCR_X509_OID_IS(SCR_X509_OID_SMTP_UTF8)) prefix = "SmtpUTF8Mailbox";
        else if (SCR_X509_OID_IS(SCR_X509_OID_XMPP)) prefix = "XmppAddr";
        else if (SCR_X509_OID_IS(SCR_X509_OID_SRV)) {
          prefix = "SRVName";
          unicode = false;
        } else if (SCR_X509_OID_IS(SCR_X509_OID_UPN)) prefix = "UPN";
        else if (SCR_X509_OID_IS(SCR_X509_OID_NAI)) prefix = "NAIRealm";
#undef SCR_X509_OID_IS
      }
      const uint8_t *value = NULL;
      size_t value_len = 0;
      uint8_t vtag = 0;
      if (oid && prefix) {
        const uint8_t *wrap = scr_der_tl(oid + len, end, &t, &len);
        if (wrap && t == 0xA0) value = scr_der_tl(wrap, wrap + len, &vtag, &value_len);
      }
      if (!value || vtag != (unicode ? 0x0C : 0x16)) {
        scr_x509_puts(b, "othername:<unsupported>");
      } else {
        scr_x509_puts(b, "othername:");
        scr_x509_put_alt_name(b, value, value_len, unicode, prefix);
      }
      return;
    }
    case 0xA3:
      scr_x509_puts(b, "X400Name:<unsupported>");
      return;
    case 0xA5:
      scr_x509_puts(b, "EdiPartyName:<unsupported>");
      return;
    default:
      return;
  }
}

/* The DER contents of the TBSCertificate parts, or an empty string when
 * the certificate does not parse. */
static ScrStr *scr_x509_name_field(ScrBytes *der, bool subject) {
  ScrX509Parts parts;
  ScrX509Buf b = {0};
  if (scr_x509_parts(SCR_X509_DER(der), &parts)) {
    const uint8_t *name = subject ? parts.subject : parts.issuer;
    if (name) scr_x509_name_print(&b, name, subject ? parts.subject_len : parts.issuer_len, true);
  }
  return scr_x509_buf_str(&b);
}

/* new X509Certificate(data).raw: the certificate's DER as a fresh Buffer.
 * Unparseable input throws Node's PEM error (exception pending, NULL). */
static ScrBytes *scr_x509_raw(const uint8_t *in, size_t n) {
  const uint8_t *der;
  size_t der_len;
  uint8_t *decoded;
  if (!scr_x509_der(in, n, &der, &der_len, &decoded)) return NULL;
  ScrBytes *out = scr_buffer_alloc_unsafe_slow((double)der_len);
  memcpy(out->data, der, der_len);
  free(decoded);
  return out;
}

ScrBytes *scr_crypto_x509_raw(ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  return scr_x509_raw(SCR_X509_DER(data));
}

ScrBytes *scr_crypto_x509_raw_str(ScrStr *pem) {
  return scr_x509_raw((const uint8_t *)pem->data, pem->len);
}

ScrStr *scr_crypto_x509_subject(ScrBytes *der) { return scr_x509_name_field(der, true); }

ScrStr *scr_crypto_x509_issuer(ScrBytes *der) { return scr_x509_name_field(der, false); }

static const uint8_t SCR_X509_OID_SAN[] = {0x55, 0x1D, 0x11};
static const uint8_t SCR_X509_OID_BASIC_CONSTRAINTS[] = {0x55, 0x1D, 0x13};
static const uint8_t SCR_X509_OID_KEY_USAGE[] = {0x55, 0x1D, 0x0F};
static const uint8_t SCR_X509_OID_AIA[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01};

/* subjectAltName: the GeneralNames joined with ", "; an empty string when
 * the certificate has no subjectAltName extension (Node's undefined). */
ScrStr *scr_crypto_x509_subject_alt_name(ScrBytes *der) {
  ScrX509Parts parts;
  ScrX509Buf b = {0};
  size_t n;
  const uint8_t *ext = scr_x509_parts(SCR_X509_DER(der), &parts)
                           ? scr_x509_ext(&parts, SCR_X509_OID_SAN, sizeof SCR_X509_OID_SAN, &n)
                           : NULL;
  uint8_t tag;
  size_t len;
  const uint8_t *names = ext ? scr_der_tl(ext, ext + n, &tag, &len) : NULL;
  if (names && tag == 0x30) {
    const uint8_t *end = names + len;
    bool first = true;
    for (const uint8_t *p = names; p < end;) {
      const uint8_t *v = scr_der_tl(p, end, &tag, &len);
      if (!v) break;
      if (!first) scr_x509_puts(&b, ", ");
      first = false;
      scr_x509_general_name(&b, tag, v, len);
      p = v + len;
    }
  }
  return scr_x509_buf_str(&b);
}

/* infoAccess: one "<method> - <GeneralName>" line per AccessDescription;
 * an empty string when the extension is absent (Node's undefined). */
ScrStr *scr_crypto_x509_info_access(ScrBytes *der) {
  ScrX509Parts parts;
  ScrX509Buf b = {0};
  size_t n;
  const uint8_t *ext = scr_x509_parts(SCR_X509_DER(der), &parts)
                           ? scr_x509_ext(&parts, SCR_X509_OID_AIA, sizeof SCR_X509_OID_AIA, &n)
                           : NULL;
  uint8_t tag;
  size_t len;
  const uint8_t *descs = ext ? scr_der_tl(ext, ext + n, &tag, &len) : NULL;
  if (descs && tag == 0x30) {
    const uint8_t *end = descs + len;
    bool first = true;
    for (const uint8_t *p = descs; p < end;) {
      const uint8_t *desc = scr_der_tl(p, end, &tag, &len);
      if (!desc || tag != 0x30) break;
      const uint8_t *desc_end = desc + len;
      p = desc_end;
      const uint8_t *method = scr_der_tl(desc, desc_end, &tag, &len);
      if (!method || tag != 0x06) continue;
      if (!first) scr_x509_putc(&b, '\n');
      first = false;
      scr_x509_oid_name(&b, method, len, scr_x509_access_names,
                        sizeof scr_x509_access_names / sizeof scr_x509_access_names[0]);
      scr_x509_puts(&b, " - ");
      const uint8_t *location = scr_der_tl(method + len, desc_end, &tag, &len);
      if (location) scr_x509_general_name(&b, tag, location, len);
    }
  }
  return scr_x509_buf_str(&b);
}

/* serialNumber: BN_bn2hex of the INTEGER ("0" for zero, whole bytes in
 * uppercase hex without leading zero bytes, '-' before a negative). */
ScrStr *scr_crypto_x509_serial_number(ScrBytes *der) {
  ScrX509Parts parts;
  ScrX509Buf b = {0};
  if (scr_x509_parts(SCR_X509_DER(der), &parts) && parts.serial_len > 0) {
    static const char hex[] = "0123456789ABCDEF";
    size_t n = parts.serial_len;
    uint8_t *mag = malloc(n);
    if (!mag) scr_trap("scriptc: out of memory\n");
    memcpy(mag, parts.serial, n);
    bool neg = (mag[0] & 0x80) != 0;
    if (neg) { /* two's complement magnitude */
      for (size_t i = 0; i < n; i++) mag[i] = (uint8_t)~mag[i];
      for (size_t i = n; i-- > 0;) {
        if (++mag[i] != 0) break;
      }
    }
    size_t i = 0;
    while (i < n && mag[i] == 0) i++;
    if (i == n) {
      scr_x509_putc(&b, '0');
    } else {
      if (neg) scr_x509_putc(&b, '-');
      for (; i < n; i++) {
        scr_x509_putc(&b, hex[mag[i] >> 4]);
        scr_x509_putc(&b, hex[mag[i] & 0x0f]);
      }
    }
    free(mag);
  }
  return scr_x509_buf_str(&b);
}

static ScrStr *scr_x509_fingerprint_alg(ScrBytes *der, const char *alg) {
  unsigned char digest[64];
  size_t dn = scr_crypto_digest_raw(alg, SCR_X509_DER(der), digest);
  static const char hex[] = "0123456789ABCDEF";
  char buf[192];
  size_t o = 0;
  for (size_t i = 0; i < dn; i++) {
    if (i > 0) buf[o++] = ':';
    buf[o++] = hex[digest[i] >> 4];
    buf[o++] = hex[digest[i] & 0x0f];
  }
  return scr_str_new(buf, o);
}

ScrStr *scr_crypto_x509_fingerprint256(ScrBytes *der) {
  return scr_x509_fingerprint_alg(der, "sha256");
}

ScrStr *scr_crypto_x509_fingerprint512(ScrBytes *der) {
  return scr_x509_fingerprint_alg(der, "sha512");
}

/* ca: X509_check_ca() == 1 — basicConstraints with cA TRUE, and a
 * keyUsage extension, when present, that allows keyCertSign. */
bool scr_crypto_x509_ca(ScrBytes *der) {
  ScrX509Parts parts;
  if (!scr_x509_parts(SCR_X509_DER(der), &parts)) return false;
  uint8_t tag;
  size_t len, n;
  const uint8_t *ku = scr_x509_ext(&parts, SCR_X509_OID_KEY_USAGE, sizeof SCR_X509_OID_KEY_USAGE, &n);
  if (ku) {
    const uint8_t *bits = scr_der_tl(ku, ku + n, &tag, &len);
    if (!bits || tag != 0x03 || len < 2 || (bits[1] & 0x04) == 0) return false;
  }
  const uint8_t *bc = scr_x509_ext(&parts, SCR_X509_OID_BASIC_CONSTRAINTS,
                                   sizeof SCR_X509_OID_BASIC_CONSTRAINTS, &n);
  if (!bc) return false;
  const uint8_t *seq = scr_der_tl(bc, bc + n, &tag, &len);
  if (!seq || tag != 0x30) return false;
  const uint8_t *flag = scr_der_tl(seq, seq + len, &tag, &len);
  return flag && tag == 0x01 && len == 1 && flag[0] != 0;
}

/* The signature AlgorithmIdentifier's OID contents, or NULL. */
static const uint8_t *scr_x509_sig_oid(ScrBytes *der, size_t *n) {
  ScrX509Parts parts;
  if (!scr_x509_parts(SCR_X509_DER(der), &parts) || !parts.sig_alg) return NULL;
  uint8_t tag;
  const uint8_t *oid = scr_der_tl(parts.sig_alg, parts.sig_alg + parts.sig_alg_len, &tag, n);
  return oid && tag == 0x06 ? oid : NULL;
}

/* signatureAlgorithm: OpenSSL's long name for the signature algorithm; an
 * empty string for an algorithm OpenSSL does not name (Node's
 * undefined). */
ScrStr *scr_crypto_x509_signature_algorithm(ScrBytes *der) {
  size_t n;
  const uint8_t *oid = scr_x509_sig_oid(der, &n);
  ScrX509Buf b = {0};
  if (oid && !scr_x509_oid_name(&b, oid, n, scr_x509_sig_names,
                                sizeof scr_x509_sig_names / sizeof scr_x509_sig_names[0]))
    b.len = 0;
  return scr_x509_buf_str(&b);
}

/* signatureAlgorithmOid: the signature algorithm's dotted OID. */
ScrStr *scr_crypto_x509_signature_algorithm_oid(ScrBytes *der) {
  size_t n;
  const uint8_t *oid = scr_x509_sig_oid(der, &n);
  ScrX509Buf b = {0};
  if (oid) scr_x509_oid_dotted(&b, oid, n);
  return scr_x509_buf_str(&b);
}
