/* node:crypto asymmetric keys and signatures over the vendored mbedTLS
 * public-key layer: createPrivateKey, createPublicKey, generateKeyPairSync
 * and generateKeyPair for "rsa", "ec" and "ed25519" keys, the
 * PrivateKeyObject and PublicKeyObject handles (type, asymmetricKeyType,
 * asymmetricKeyDetails, export(), equals()), crypto.sign and crypto.verify,
 * and the Sign and Verify objects of createSign and createVerify. Keys read
 * and write PEM and DER as PKCS#1, SEC1, PKCS#8 and SubjectPublicKeyInfo,
 * and JWK; the EC curves are prime256v1, secp384r1, secp521r1 and
 * secp256k1, and the Ed25519 arithmetic is scr_ed25519.c. Argument checks
 * and errors follow Node 24's lib/internal/crypto/keys.js, keygen.js and
 * sig.js. Encrypted keys and other key types throw a coded SC2020 error.
 * All arguments are borrowed. */
#include "scr_runtime.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/asn1.h"
#include "mbedtls/asn1write.h"
#include "mbedtls/base64.h"
#include "mbedtls/bignum.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/ecp.h"
#include "mbedtls/md.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/rsa.h"
#include "mbedtls/x509_crt.h"

#include "scr_pki.h"

/* ── errors ───────────────────────────────────────────────────────────── */

static void sp_throw(int kind, const char *code, const char *message) {
  scr_throw_error_msg_code(kind, message, strlen(message), code);
}

void scr_pki_throw_fmt(int kind, const char *code, const char *fmt, ...) {
  va_list ap, sized;
  va_start(ap, fmt);
  va_copy(sized, ap);
  int n = vsnprintf(NULL, 0, fmt, sized);
  va_end(sized);
  if (n < 0) n = 0;
  char *message = malloc((size_t)n + 1);
  if (!message) scr_trap("scriptc: out of memory\n");
  vsnprintf(message, (size_t)n + 1, fmt, ap);
  va_end(ap);
  if (code) scr_throw_error_msg_code(kind, message, (size_t)n, code);
  else scr_throw_error_msg(kind, message, (size_t)n);
  free(message);
}

/* The "Received" text of Node's ERR_INVALID_ARG_VALUE and ERR_OUT_OF_RANGE
 * messages: a string as util.inspect quotes it (cut at 128 UTF-16 units
 * plus "..."), a number as ERR_OUT_OF_RANGE prints it when `range`, any
 * other value as its sketch. +1. */
static ScrStr *sp_received(const ScrDyn *got, bool range) {
  if (got->kind == SCR_DYN_STR) return scr_str_inspect_quoted(got->v.str, true);
  char text[96];
  if (range && got->kind == SCR_DYN_NUM) return scr_str_new(text, scr_num_received(got->v.num, text));
  const char *lite = scr_dyn_inspect_lite(got, text, sizeof text);
  return scr_str_new(lite, strlen(lite));
}

/* ERR_INVALID_ARG_VALUE for an option ("The property 'options.type' is
 * invalid. Received 'spki'"). */
static void sp_property_invalid(const char *name, const ScrDyn *got) {
  ScrStr *received = sp_received(got, false);
  scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", "The property '%s' is invalid. Received %.*s", name,
                    (int)received->len, received->data);
  scr_str_release(received);
}

static void sp_unsupported_input(void) {
  sp_throw(SCR_ERR_ERROR, "ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported");
}

/* The coded refusal for a form this runtime does not implement. */
static void sp_not_supported(const char *what) {
  scr_pki_throw_fmt(SCR_ERR_ERROR, "SC2020", "'%s' is part of the standard library types but has no scriptc lowering yet",
                    what);
}

static int sp_random(void *state, unsigned char *out, size_t len) {
  (void)state;
  arc4random_buf(out, len);
  return 0;
}

/* ── Ed25519 ──────────────────────────────────────────────────────────
 * The arithmetic is scr_ed25519.c, which links only into programs that
 * name Ed25519 and installs itself here at startup. Keys are the 32-byte
 * seed and the 32-byte encoded public point. */
const ScrPkiEd25519 *scr_pki_ed25519 = NULL;

/* The Ed25519 arithmetic, or NULL with a coded SC2020 error pending. */
static const ScrPkiEd25519 *sp_ed(void) {
  if (!scr_pki_ed25519)
    sp_throw(SCR_ERR_ERROR, "SC2020",
             "Ed25519 keys are supported when a string literal in the program names 'ed25519'");
  return scr_pki_ed25519;
}

bool scr_pki_ed25519_ready(void) { return sp_ed() != NULL; }

static bool sp_ed_verify(const ScrPkiEd25519 *ed, const uint8_t pub[32], const uint8_t *m, size_t n,
                         const uint8_t *sig, size_t sig_len) {
  return sig_len == 64 && ed->verify(pub, m, n, sig);
}

/* ── option bags ──────────────────────────────────────────────────────── */

static bool sp_is_object(const ScrDyn *v) { return v != NULL && v->kind == SCR_DYN_OBJ; }

/* A statically typed object argument (a record or class instance) as a
 * plain object: +1, or NULL with the error pending. Other values are
 * retained as they are. */
static ScrDyn *sp_plain(const ScrDyn *v) {
  if (v != NULL && v->kind == SCR_DYN_TYPED_REF) return scr_dyn_typed_ref_materialize(v);
  return scr_dyn_retain((ScrDyn *)(v ? v : scr_dyn_undefined()));
}

/* A borrowed option, or the undefined singleton. */
static const ScrDyn *sp_opt(const ScrDyn *obj, const char *key) {
  const ScrDyn *v = sp_is_object(obj) ? scr_dyn_obj_get(obj, key, strlen(key)) : NULL;
  return v ? v : scr_dyn_undefined();
}

static bool sp_is_str(const ScrDyn *v, const char *text) {
  size_t n = strlen(text);
  return v->kind == SCR_DYN_STR && v->v.str->len == n && memcmp(v->v.str->data, text, n) == 0;
}

static bool sp_absent(const ScrDyn *v) { return v->kind == SCR_DYN_UNDEF; }

/* ── keys ─────────────────────────────────────────────────────────────── */

typedef struct SpKey {
  size_t rc;
  mbedtls_pk_context pk; /* RSA and EC keys */
  bool private_key;
  bool ed25519; /* an Ed25519 key: ed_seed (private keys) and ed_pub */
  uint8_t ed_seed[32];
  uint8_t ed_pub[32];
} SpKey;

static void *sp_key_retain(void *h) {
  SpKey *k = h;
  if (k->rc != SIZE_MAX) k->rc++;
  return h;
}

static void sp_key_release(void *h) {
  SpKey *k = h;
  if (!k || k->rc == SIZE_MAX || --k->rc != 0) return;
  mbedtls_pk_free(&k->pk);
  mbedtls_platform_zeroize(k, sizeof *k);
  free(k);
}

static SpKey *sp_key_alloc(bool private_key) {
  SpKey *k = calloc(1, sizeof *k);
  if (!k) scr_trap("scriptc: out of memory\n");
  k->rc = 1;
  k->private_key = private_key;
  mbedtls_pk_init(&k->pk);
  return k;
}

static void sp_key_install(void);

/* Boxes the key (consuming the caller's reference). */
static ScrDyn *sp_key_box(SpKey *k) {
  sp_key_install();
  ScrDyn *box = scr_dyn_new_handle(k, k->private_key ? SCR_DYNH_PRIVATE_KEY : SCR_DYNH_PUBLIC_KEY);
  sp_key_release(k);
  return box;
}

static SpKey *sp_key_of(const ScrDyn *v) {
  if (v == NULL || v->kind != SCR_DYN_HANDLE) return NULL;
  if (v->v.handle.tag != SCR_DYNH_PRIVATE_KEY && v->v.handle.tag != SCR_DYNH_PUBLIC_KEY) return NULL;
  return v->v.handle.ptr;
}

bool scr_crypto_is_asymmetric_key(const ScrDyn *value) { return sp_key_of(value) != NULL; }

/* The type getter of a KeyObject value: "private", "public", or NULL for
 * anything else. */
const char *scr_crypto_asymmetric_key_type(const ScrDyn *value) {
  SpKey *k = sp_key_of(value);
  return k ? (k->private_key ? "private" : "public") : NULL;
}

static bool sp_is_rsa(const SpKey *k) { return mbedtls_pk_get_type(&k->pk) == MBEDTLS_PK_RSA; }

static bool sp_is_ec(const SpKey *k) { return mbedtls_pk_get_type(&k->pk) == MBEDTLS_PK_ECKEY; }

static bool sp_is_ed(const SpKey *k) { return k->ed25519; }

typedef struct {
  const char *name;  /* OpenSSL short name (namedCurve) */
  const char *nist;  /* EC_curve_nist2nid alias, or NULL */
  const char *jwk;   /* JWK crv */
  mbedtls_ecp_group_id id;
} SpCurve;

static const SpCurve sp_curves[] = {
    {"prime256v1", "P-256", "P-256", MBEDTLS_ECP_DP_SECP256R1},
    {"secp384r1", "P-384", "P-384", MBEDTLS_ECP_DP_SECP384R1},
    {"secp521r1", "P-521", "P-521", MBEDTLS_ECP_DP_SECP521R1},
    {"secp256k1", NULL, "secp256k1", MBEDTLS_ECP_DP_SECP256K1},
};

static const SpCurve *sp_curve_by_id(mbedtls_ecp_group_id id) {
  for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
    if (sp_curves[i].id == id) return &sp_curves[i];
  return NULL;
}

static const SpCurve *sp_curve_of(const SpKey *k) {
  return sp_is_ec(k) ? sp_curve_by_id(mbedtls_pk_ec(k->pk)->MBEDTLS_PRIVATE(grp).id) : NULL;
}

/* A parsed key is usable when it is RSA or EC on a curve above. */
static bool sp_key_supported(const SpKey *k) {
  return sp_is_ed(k) || sp_is_rsa(k) || (sp_is_ec(k) && sp_curve_of(k) != NULL);
}

/* ── DER writing ──────────────────────────────────────────────────────── */

/* mbedtls writes DER backwards into the end of a buffer; these helpers
 * answer the written length or a negative error. */
#define SP_DER_MAX 8192

static int sp_write_private_der(SpKey *k, unsigned char *buf, size_t size) {
  return mbedtls_pk_write_key_der(&k->pk, buf, size);
}

/* Ed25519's PKCS#8 and SubjectPublicKeyInfo prefixes (RFC 8410): the
 * 32-byte seed or public key follows. */
static const uint8_t sp_ed_pkcs8_prefix[16] = {0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
                                               0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20};
static const uint8_t sp_ed_spki_prefix[12] = {0x30, 0x2a, 0x30, 0x05, 0x06, 0x03,
                                              0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};

/* Writes prefix || 32 bytes at the end of buf, as the mbedtls writers do. */
static int sp_write_ed_der(const uint8_t *prefix, size_t prefix_len, const uint8_t key[32],
                           unsigned char *buf, size_t size) {
  size_t n = prefix_len + 32;
  if (size < n) return MBEDTLS_ERR_ASN1_BUF_TOO_SMALL;
  memcpy(buf + size - n, prefix, prefix_len);
  memcpy(buf + size - 32, key, 32);
  return (int)n;
}

static int sp_write_spki_der(SpKey *k, unsigned char *buf, size_t size) {
  if (sp_is_ed(k)) return sp_write_ed_der(sp_ed_spki_prefix, sizeof sp_ed_spki_prefix, k->ed_pub, buf, size);
  return mbedtls_pk_write_pubkey_der(&k->pk, buf, size);
}

/* RSAPublicKey (PKCS#1) DER. */
static int sp_write_pkcs1_public_der(SpKey *k, unsigned char *buf, size_t size) {
  unsigned char *p = buf + size;
  return mbedtls_pk_write_pubkey(&p, buf, &k->pk);
}

/* PKCS#8 PrivateKeyInfo around the PKCS#1 or SEC1 key, as OpenSSL writes
 * it: version 0, the AlgorithmIdentifier (rsaEncryption with NULL
 * parameters, or id-ecPublicKey with the curve OID), and the inner key,
 * which for EC omits the parameters field. */
static int sp_write_pkcs8_der(SpKey *k, unsigned char *buf, size_t size) {
  if (sp_is_ed(k))
    return sp_write_ed_der(sp_ed_pkcs8_prefix, sizeof sp_ed_pkcs8_prefix, k->ed_seed, buf, size);
  unsigned char inner[SP_DER_MAX];
  size_t inner_len;
  if (sp_is_rsa(k)) {
    int n = sp_write_private_der(k, inner, sizeof inner);
    if (n < 0) return n;
    inner_len = (size_t)n;
    memmove(inner, inner + sizeof inner - inner_len, inner_len);
  } else {
    /* ECPrivateKey ::= SEQUENCE { version 1, privateKey OCTET STRING,
     * [1] publicKey BIT STRING } */
    const mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
    unsigned char *c = inner + sizeof inner;
    size_t len = 0;
    int r;
    unsigned char point[160];
    size_t point_len;
    if ((r = mbedtls_ecp_point_write_binary(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q),
                                            MBEDTLS_ECP_PF_UNCOMPRESSED, &point_len, point,
                                            sizeof point)) != 0)
      return r;
    size_t pub_len = 0;
    if ((r = mbedtls_asn1_write_bitstring(&c, inner, point, point_len * 8)) < 0) return r;
    pub_len += (size_t)r;
    if ((r = mbedtls_asn1_write_len(&c, inner, pub_len)) < 0) return r;
    pub_len += (size_t)r;
    if ((r = mbedtls_asn1_write_tag(&c, inner, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1)) < 0)
      return r;
    pub_len += (size_t)r;
    len += pub_len;
    size_t d_len = (ec->MBEDTLS_PRIVATE(grp).nbits + 7) / 8;
    unsigned char d[72];
    if ((r = mbedtls_mpi_write_binary(&ec->MBEDTLS_PRIVATE(d), d, d_len)) != 0) return r;
    if ((r = mbedtls_asn1_write_octet_string(&c, inner, d, d_len)) < 0) return r;
    len += (size_t)r;
    mbedtls_platform_zeroize(d, sizeof d);
    if ((r = mbedtls_asn1_write_int(&c, inner, 1)) < 0) return r;
    len += (size_t)r;
    if ((r = mbedtls_asn1_write_len(&c, inner, len)) < 0) return r;
    len += (size_t)r;
    if ((r = mbedtls_asn1_write_tag(&c, inner, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0)
      return r;
    len += (size_t)r;
    inner_len = len;
    memmove(inner, c, inner_len);
  }
  unsigned char *c = buf + size;
  size_t len = 0;
  int r;
  if ((r = mbedtls_asn1_write_octet_string(&c, buf, inner, inner_len)) < 0) goto done;
  len += (size_t)r;
  {
    const char *oid;
    size_t oid_len;
    size_t alg_len = 0;
    if (sp_is_rsa(k)) {
      if ((r = mbedtls_asn1_write_null(&c, buf)) < 0) goto done;
      alg_len += (size_t)r;
      oid = MBEDTLS_OID_PKCS1_RSA;
      oid_len = MBEDTLS_OID_SIZE(MBEDTLS_OID_PKCS1_RSA);
    } else {
      const char *curve_oid;
      size_t curve_oid_len;
      if ((r = mbedtls_oid_get_oid_by_ec_grp(mbedtls_pk_ec(k->pk)->MBEDTLS_PRIVATE(grp).id, &curve_oid,
                                             &curve_oid_len)) != 0)
        goto done;
      if ((r = mbedtls_asn1_write_oid(&c, buf, curve_oid, curve_oid_len)) < 0) goto done;
      alg_len += (size_t)r;
      oid = MBEDTLS_OID_EC_ALG_UNRESTRICTED;
      oid_len = MBEDTLS_OID_SIZE(MBEDTLS_OID_EC_ALG_UNRESTRICTED);
    }
    if ((r = mbedtls_asn1_write_oid(&c, buf, oid, oid_len)) < 0) goto done;
    alg_len += (size_t)r;
    if ((r = mbedtls_asn1_write_len(&c, buf, alg_len)) < 0) goto done;
    alg_len += (size_t)r;
    if ((r = mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0)
      goto done;
    alg_len += (size_t)r;
    len += alg_len;
  }
  if ((r = mbedtls_asn1_write_int(&c, buf, 0)) < 0) goto done;
  len += (size_t)r;
  if ((r = mbedtls_asn1_write_len(&c, buf, len)) < 0) goto done;
  len += (size_t)r;
  if ((r = mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0)
    goto done;
  len += (size_t)r;
  r = (int)len;
done:
  mbedtls_platform_zeroize(inner, sizeof inner);
  return r;
}

/* PEM armor with 64-character base64 lines and a final newline. */
static ScrStr *sp_pem(const char *label, const unsigned char *der, size_t len) {
  size_t b64_len = 0;
  mbedtls_base64_encode(NULL, 0, &b64_len, der, len);
  unsigned char *b64 = malloc(b64_len + 1);
  char *out = malloc(b64_len + b64_len / 64 + 2 * strlen(label) + 64);
  if (!b64 || !out) scr_trap("scriptc: out of memory\n");
  mbedtls_base64_encode(b64, b64_len + 1, &b64_len, der, len);
  size_t o = (size_t)sprintf(out, "-----BEGIN %s-----\n", label);
  for (size_t i = 0; i < b64_len; i += 64) {
    size_t n = b64_len - i < 64 ? b64_len - i : 64;
    memcpy(out + o, b64 + i, n);
    o += n;
    out[o++] = '\n';
  }
  o += (size_t)sprintf(out + o, "-----END %s-----\n", label);
  ScrStr *s = scr_str_new(out, o);
  mbedtls_platform_zeroize(b64, b64_len);
  mbedtls_platform_zeroize(out, o);
  free(b64);
  free(out);
  return s;
}

static ScrDyn *sp_dyn_buffer(const unsigned char *data, size_t len) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)len);
  bytes->is_buffer = true;
  if (len) memcpy(bytes->data, data, len);
  ScrDyn *d = scr_dyn_new_buffer(bytes);
  scr_bytes_release(bytes);
  return d;
}

static ScrDyn *sp_dyn_str(ScrStr *s) {
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

/* ── JWK ──────────────────────────────────────────────────────────────── */

/* base64url without padding of the big-endian integer `x` in `len` bytes
 * (0 = its minimal length). */
static ScrDyn *sp_jwk_int(const mbedtls_mpi *x, size_t len) {
  if (len == 0) len = mbedtls_mpi_size(x);
  if (len == 0) len = 1;
  unsigned char *raw = malloc(len);
  size_t b64_len = 0;
  if (!raw) scr_trap("scriptc: out of memory\n");
  mbedtls_mpi_write_binary(x, raw, len);
  mbedtls_base64_encode(NULL, 0, &b64_len, raw, len);
  unsigned char *b64 = malloc(b64_len + 1);
  if (!b64) scr_trap("scriptc: out of memory\n");
  mbedtls_base64_encode(b64, b64_len + 1, &b64_len, raw, len);
  size_t o = 0;
  for (size_t i = 0; i < b64_len; i++) {
    unsigned char c = b64[i];
    if (c == '=') break;
    b64[o++] = c == '+' ? '-' : c == '/' ? '_' : c;
  }
  ScrDyn *d = sp_dyn_str(scr_str_new((const char *)b64, o));
  mbedtls_platform_zeroize(raw, len);
  free(raw);
  free(b64);
  return d;
}

static void sp_set(ScrDyn *obj, const char *key, ScrDyn *value) {
  scr_dyn_obj_set(obj, key, strlen(key), value);
}

/* base64url without padding of raw bytes. */
static ScrDyn *sp_b64url(const uint8_t *raw, size_t len) {
  size_t b64_len = 0;
  mbedtls_base64_encode(NULL, 0, &b64_len, raw, len);
  unsigned char *b64 = malloc(b64_len + 1);
  if (!b64) scr_trap("scriptc: out of memory\n");
  mbedtls_base64_encode(b64, b64_len + 1, &b64_len, raw, len);
  size_t o = 0;
  for (size_t i = 0; i < b64_len; i++) {
    unsigned char c = b64[i];
    if (c == '=') break;
    b64[o++] = c == '+' ? '-' : c == '/' ? '_' : c;
  }
  ScrDyn *d = sp_dyn_str(scr_str_new((const char *)b64, o));
  mbedtls_platform_zeroize(b64, b64_len);
  free(b64);
  return d;
}

static ScrDyn *sp_export_jwk(SpKey *k) {
  ScrDyn *jwk = scr_dyn_new_obj();
  if (sp_is_ed(k)) {
    sp_set(jwk, "kty", sp_dyn_str(scr_str_new("OKP", 3)));
    sp_set(jwk, "crv", sp_dyn_str(scr_str_new("Ed25519", 7)));
    sp_set(jwk, "x", sp_b64url(k->ed_pub, 32));
    if (k->private_key) sp_set(jwk, "d", sp_b64url(k->ed_seed, 32));
    return jwk;
  }
  if (sp_is_rsa(k)) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(k->pk);
    mbedtls_mpi n, e, d, p, q, dp, dq, qi;
    mbedtls_mpi *all[] = {&n, &e, &d, &p, &q, &dp, &dq, &qi};
    for (size_t i = 0; i < 8; i++) mbedtls_mpi_init(all[i]);
    mbedtls_rsa_export(rsa, &n, k->private_key ? &p : NULL, k->private_key ? &q : NULL,
                       k->private_key ? &d : NULL, &e);
    sp_set(jwk, "kty", sp_dyn_str(scr_str_new("RSA", 3)));
    sp_set(jwk, "n", sp_jwk_int(&n, 0));
    sp_set(jwk, "e", sp_jwk_int(&e, 0));
    if (k->private_key) {
      mbedtls_rsa_export_crt(rsa, &dp, &dq, &qi);
      sp_set(jwk, "d", sp_jwk_int(&d, 0));
      sp_set(jwk, "p", sp_jwk_int(&p, 0));
      sp_set(jwk, "q", sp_jwk_int(&q, 0));
      sp_set(jwk, "dp", sp_jwk_int(&dp, 0));
      sp_set(jwk, "dq", sp_jwk_int(&dq, 0));
      sp_set(jwk, "qi", sp_jwk_int(&qi, 0));
    }
    for (size_t i = 0; i < 8; i++) mbedtls_mpi_free(all[i]);
  } else {
    const mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
    const SpCurve *curve = sp_curve_of(k);
    size_t size = (ec->MBEDTLS_PRIVATE(grp).nbits + 7) / 8;
    sp_set(jwk, "kty", sp_dyn_str(scr_str_new("EC", 2)));
    sp_set(jwk, "x", sp_jwk_int(&ec->MBEDTLS_PRIVATE(Q).MBEDTLS_PRIVATE(X), size));
    sp_set(jwk, "y", sp_jwk_int(&ec->MBEDTLS_PRIVATE(Q).MBEDTLS_PRIVATE(Y), size));
    sp_set(jwk, "crv", sp_dyn_str(scr_str_new(curve->jwk, strlen(curve->jwk))));
    if (k->private_key) sp_set(jwk, "d", sp_jwk_int(&ec->MBEDTLS_PRIVATE(d), size));
  }
  return jwk;
}

/* Decodes a JWK base64url member into `x`; false when it is missing or
 * not a string. */
static bool sp_jwk_read(const ScrDyn *jwk, const char *key, mbedtls_mpi *x) {
  const ScrDyn *v = sp_opt(jwk, key);
  if (v->kind != SCR_DYN_STR) return false;
  size_t n = v->v.str->len;
  unsigned char *b64 = malloc(n + 4);
  unsigned char *raw = malloc(n + 4);
  if (!b64 || !raw) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < n; i++) {
    char c = v->v.str->data[i];
    b64[i] = (unsigned char)(c == '-' ? '+' : c == '_' ? '/' : c);
  }
  while (n % 4) b64[n++] = '=';
  size_t raw_len = 0;
  bool ok = mbedtls_base64_decode(raw, n, &raw_len, b64, n) == 0 &&
            mbedtls_mpi_read_binary(x, raw, raw_len) == 0;
  mbedtls_platform_zeroize(raw, n);
  free(b64);
  free(raw);
  return ok;
}

/* Decodes a 32-byte JWK base64url member; false when it is missing, not a
 * string, or another length. */
static bool sp_jwk_bytes(const ScrDyn *jwk, const char *key, uint8_t out[32]) {
  const ScrDyn *v = sp_opt(jwk, key);
  if (v->kind != SCR_DYN_STR || v->v.str->len != 43) return false;
  unsigned char b64[44];
  for (size_t i = 0; i < 43; i++) {
    char c = v->v.str->data[i];
    b64[i] = (unsigned char)(c == '-' ? '+' : c == '_' ? '/' : c);
  }
  b64[43] = '=';
  size_t n = 0;
  return mbedtls_base64_decode(out, 32, &n, b64, 44) == 0 && n == 32;
}

static void sp_invalid_jwk(void) {
  sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK data");
}

/* A key from a JWK object: RSA (n, e, and d, p, q for a private key) or EC
 * (crv, x, y, and d). NULL with the error pending. */
static SpKey *sp_key_from_jwk_plain(const ScrDyn *jwk, bool want_private);

static SpKey *sp_key_from_jwk(const ScrDyn *jwk, bool want_private) {
  ScrDyn *plain = sp_plain(jwk);
  if (!plain) return NULL;
  SpKey *k = sp_key_from_jwk_plain(plain, want_private);
  scr_dyn_release(plain);
  return k;
}

static SpKey *sp_key_from_jwk_plain(const ScrDyn *jwk, bool want_private) {
  if (!sp_is_object(jwk)) {
    scr_dyn_prop_type_fail("key.key", "of type object", jwk);
    return NULL;
  }
  const ScrDyn *kty = sp_opt(jwk, "kty");
  if (kty->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("key.kty", "of type string", kty);
    return NULL;
  }
  bool has_d = !sp_absent(sp_opt(jwk, "d"));
  if (want_private && !has_d) {
    sp_invalid_jwk();
    return NULL;
  }
  bool private_key = want_private;
  SpKey *k = sp_key_alloc(private_key);
  bool ok = false;
  if (sp_is_str(kty, "OKP")) {
    const ScrDyn *crv = sp_opt(jwk, "crv");
    if (!sp_is_str(crv, "Ed25519")) {
      sp_key_release(k);
      if (crv->kind != SCR_DYN_STR) {
        scr_dyn_prop_type_fail("key.crv", "of type string", crv);
        return NULL;
      }
      sp_not_supported("JWK keys of this crv");
      return NULL;
    }
    k->ed25519 = true;
    if (private_key) {
      ok = sp_jwk_bytes(jwk, "d", k->ed_seed);
      if (ok) {
        const ScrPkiEd25519 *ed = sp_ed();
        if (!ed) {
          sp_key_release(k);
          return NULL;
        }
        ed->public_key(k->ed_pub, k->ed_seed);
      }
    } else {
      ok = sp_jwk_bytes(jwk, "x", k->ed_pub);
    }
  } else if (sp_is_str(kty, "RSA")) {
    mbedtls_mpi n, e, d, p, q;
    mbedtls_mpi_init(&n);
    mbedtls_mpi_init(&e);
    mbedtls_mpi_init(&d);
    mbedtls_mpi_init(&p);
    mbedtls_mpi_init(&q);
    if (sp_jwk_read(jwk, "n", &n) && sp_jwk_read(jwk, "e", &e) &&
        mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) == 0) {
      mbedtls_rsa_context *rsa = mbedtls_pk_rsa(k->pk);
      if (private_key) {
        ok = sp_jwk_read(jwk, "d", &d) && sp_jwk_read(jwk, "p", &p) && sp_jwk_read(jwk, "q", &q) &&
             mbedtls_rsa_import(rsa, &n, &p, &q, &d, &e) == 0 && mbedtls_rsa_complete(rsa) == 0 &&
             mbedtls_rsa_check_privkey(rsa) == 0;
      } else {
        ok = mbedtls_rsa_import(rsa, &n, NULL, NULL, NULL, &e) == 0 &&
             mbedtls_rsa_complete(rsa) == 0 && mbedtls_rsa_check_pubkey(rsa) == 0;
      }
    }
    mbedtls_mpi_free(&n);
    mbedtls_mpi_free(&e);
    mbedtls_mpi_free(&d);
    mbedtls_mpi_free(&p);
    mbedtls_mpi_free(&q);
  } else if (sp_is_str(kty, "EC")) {
    const ScrDyn *crv = sp_opt(jwk, "crv");
    if (crv->kind != SCR_DYN_STR) {
      sp_key_release(k);
      scr_dyn_prop_type_fail("key.crv", "of type string", crv);
      return NULL;
    }
    const SpCurve *curve = NULL;
    for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
      if (sp_is_str(crv, sp_curves[i].jwk)) curve = &sp_curves[i];
    if (!curve) {
      sp_key_release(k);
      sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
      return NULL;
    }
    if (mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) == 0) {
      mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
      mbedtls_ecp_point *Q = &ec->MBEDTLS_PRIVATE(Q);
      ok = mbedtls_ecp_group_load(&ec->MBEDTLS_PRIVATE(grp), curve->id) == 0 &&
           sp_jwk_read(jwk, "x", &Q->MBEDTLS_PRIVATE(X)) &&
           sp_jwk_read(jwk, "y", &Q->MBEDTLS_PRIVATE(Y)) &&
           mbedtls_mpi_lset(&Q->MBEDTLS_PRIVATE(Z), 1) == 0 &&
           mbedtls_ecp_check_pubkey(&ec->MBEDTLS_PRIVATE(grp), Q) == 0;
      if (ok && private_key)
        ok = sp_jwk_read(jwk, "d", &ec->MBEDTLS_PRIVATE(d)) &&
             mbedtls_ecp_check_privkey(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(d)) == 0;
    }
  } else {
    sp_key_release(k);
    sp_not_supported("JWK keys of this kty");
    return NULL;
  }
  if (!ok) {
    sp_key_release(k);
    sp_invalid_jwk();
    return NULL;
  }
  return k;
}

/* ── parsing ──────────────────────────────────────────────────────────── */

/* The private key of a public SpKey derived from `k`. */
static SpKey *sp_public_of(SpKey *k) {
  if (sp_is_ed(k)) {
    SpKey *pub = sp_key_alloc(false);
    pub->ed25519 = true;
    memcpy(pub->ed_pub, k->ed_pub, 32);
    return pub;
  }
  unsigned char der[SP_DER_MAX];
  int n = sp_write_spki_der(k, der, sizeof der);
  SpKey *pub = sp_key_alloc(false);
  if (n < 0 || mbedtls_pk_parse_public_key(&pub->pk, der + sizeof der - n, (size_t)n) != 0) {
    sp_key_release(pub);
    return NULL;
  }
  return pub;
}

/* Parses key material (PEM or DER bytes). `private_key` selects
 * createPrivateKey's parse (PKCS#1, SEC1, PKCS#8) or createPublicKey's
 * (SubjectPublicKeyInfo, PKCS#1 RSAPublicKey, then a private key or an
 * X.509 certificate, whose public key it takes). NULL with Node's
 * decoder error pending. */
/* The DER of the first PEM block in data (+1 malloc'd in *out), or the
 * data itself when it has no PEM armor (*out NULL). */
static bool sp_der_of(const unsigned char *data, size_t len, unsigned char **out, const unsigned char **der,
                      size_t *der_len) {
  *out = NULL;
  const unsigned char *begin = NULL;
  for (size_t i = 0; i + 11 <= len; i++) {
    if (memcmp(data + i, "-----BEGIN ", 11) == 0) {
      begin = data + i;
      break;
    }
  }
  if (!begin) {
    *der = data;
    *der_len = len;
    return true;
  }
  const unsigned char *end = data + len;
  const unsigned char *body = memchr(begin, '\n', (size_t)(end - begin));
  if (!body) return false;
  body++;
  unsigned char *b64 = malloc((size_t)(end - body) + 1);
  unsigned char *raw = malloc((size_t)(end - body) + 1);
  if (!b64 || !raw) scr_trap("scriptc: out of memory\n");
  size_t n = 0;
  for (const unsigned char *p = body; p < end && *p != '-'; p++)
    if (*p != '\n' && *p != '\r' && *p != ' ' && *p != '\t') b64[n++] = *p;
  size_t raw_len = 0;
  bool ok = mbedtls_base64_decode(raw, (size_t)(end - body) + 1, &raw_len, b64, n) == 0;
  free(b64);
  if (!ok) {
    free(raw);
    return false;
  }
  *out = raw;
  *der = raw;
  *der_len = raw_len;
  return true;
}

/* The SubjectPublicKeyInfo element of an X.509 certificate's DER. */
static bool sp_cert_spki(const unsigned char *der, size_t len, const unsigned char **spki, size_t *spki_len) {
  unsigned char *p = (unsigned char *)der;
  const unsigned char *end = der + len;
  size_t n;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return false;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return false;
  const unsigned char *tbs_end = p + n;
  /* [0] version, serialNumber, signature, issuer, validity, subject */
  if (mbedtls_asn1_get_tag(&p, tbs_end, &n, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0) == 0)
    p += n;
  int tags[] = {MBEDTLS_ASN1_INTEGER, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE,
                MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE,
                MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE};
  for (size_t i = 0; i < 5; i++) {
    if (mbedtls_asn1_get_tag(&p, tbs_end, &n, tags[i]) != 0) return false;
    p += n;
  }
  const unsigned char *start = p;
  if (mbedtls_asn1_get_tag(&p, tbs_end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return false;
  *spki = start;
  *spki_len = (size_t)(p + n - start);
  return true;
}

/* An Ed25519 key from PKCS#8 or SubjectPublicKeyInfo DER, or (for a public
 * key) the key of an X.509 certificate; NULL when the DER is none of
 * these, or with *failed set and an error pending. A private key wanted
 * as public answers its public key. */
static SpKey *sp_ed_from_der(const unsigned char *der, size_t len, bool private_key, bool *failed) {
  *failed = false;
  if (len == 48 && memcmp(der, sp_ed_pkcs8_prefix, 16) == 0) {
    const ScrPkiEd25519 *ed = sp_ed();
    if (!ed) {
      *failed = true;
      return NULL;
    }
    SpKey *k = sp_key_alloc(private_key);
    k->ed25519 = true;
    ed->public_key(k->ed_pub, der + 16);
    if (private_key) memcpy(k->ed_seed, der + 16, 32);
    return k;
  }
  if (private_key) return NULL;
  const unsigned char *spki = der;
  size_t spki_len = len;
  if (!(len == 44 && memcmp(der, sp_ed_spki_prefix, 12) == 0) && !sp_cert_spki(der, len, &spki, &spki_len))
    return NULL;
  if (spki_len != 44 || memcmp(spki, sp_ed_spki_prefix, 12) != 0) return NULL;
  SpKey *k = sp_key_alloc(false);
  k->ed25519 = true;
  memcpy(k->ed_pub, spki + 12, 32);
  return k;
}

static SpKey *sp_parse(const unsigned char *data, size_t len, bool private_key) {
  {
    unsigned char *decoded;
    const unsigned char *der;
    size_t der_len;
    if (sp_der_of(data, len, &decoded, &der, &der_len)) {
      bool failed;
      SpKey *ed = sp_ed_from_der(der, der_len, private_key, &failed);
      if (decoded) {
        mbedtls_platform_zeroize(decoded, der_len);
        free(decoded);
      }
      if (ed || failed) return ed;
    }
  }
  /* mbedtls reads PEM from a NUL-terminated buffer whose length counts the
   * NUL. */
  bool pem = false;
  for (size_t i = 0; i + 11 <= len; i++) {
    if (memcmp(data + i, "-----BEGIN ", 11) == 0) {
      pem = true;
      break;
    }
  }
  unsigned char *buf = malloc(len + 1);
  if (!buf) scr_trap("scriptc: out of memory\n");
  memcpy(buf, data, len);
  buf[len] = 0;
  size_t n = pem ? len + 1 : len;
  SpKey *k = sp_key_alloc(private_key);
  bool ok;
  if (private_key) {
    ok = mbedtls_pk_parse_key(&k->pk, buf, n, NULL, 0, sp_random, NULL) == 0;
  } else {
    ok = mbedtls_pk_parse_public_key(&k->pk, buf, n) == 0;
    if (!ok) {
      SpKey *priv = sp_key_alloc(true);
      mbedtls_pk_free(&k->pk);
      mbedtls_pk_init(&k->pk);
      if (mbedtls_pk_parse_key(&priv->pk, buf, n, NULL, 0, sp_random, NULL) == 0) {
        sp_key_release(k);
        k = sp_public_of(priv);
        ok = k != NULL;
        if (!k) k = sp_key_alloc(false);
      } else {
        mbedtls_x509_crt crt;
        mbedtls_x509_crt_init(&crt);
        if (mbedtls_x509_crt_parse(&crt, buf, n) == 0) {
          unsigned char der[SP_DER_MAX];
          int w = mbedtls_pk_write_pubkey_der(&crt.pk, der, sizeof der);
          ok = w > 0 && mbedtls_pk_parse_public_key(&k->pk, der + sizeof der - w, (size_t)w) == 0;
        }
        mbedtls_x509_crt_free(&crt);
      }
      sp_key_release(priv);
    }
  }
  mbedtls_platform_zeroize(buf, len);
  free(buf);
  if (!ok) {
    sp_key_release(k);
    sp_unsupported_input();
    return NULL;
  }
  if (!sp_key_supported(k)) {
    sp_key_release(k);
    sp_not_supported("crypto keys of this type");
    return NULL;
  }
  return k;
}

/* The bytes of a string or buffer source, +1; NULL when `v` is neither. */
static ScrBytes *sp_source_bytes(const ScrDyn *v, const ScrDyn *encoding) {
  if (v->kind == SCR_DYN_STR) {
    bool named = encoding != NULL && encoding->kind == SCR_DYN_STR;
    ScrStr *utf8 = named ? NULL : scr_str_new("utf8", 4);
    ScrBytes *b = scr_bytes_from_str_checked(v->v.str, named ? encoding->v.str : utf8);
    if (utf8) scr_str_release(utf8);
    return b;
  }
  if (v->kind == SCR_DYN_BYTES || scr_buffer_storage_is(v)) return scr_bytes_buffer_source(v);
  return NULL;
}

static const char sp_key_input_types[] =
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, or URL";

/* createPrivateKey / createPublicKey: a PEM string or buffer, or
 * { key, format, type, encoding, passphrase }; createPublicKey also takes
 * a private KeyObject. */
static ScrDyn *sp_create_key(ScrDyn *input, bool private_key) {
  if (input->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(input);
    if (!value) return NULL;
    ScrDyn *result = sp_create_key(value, private_key);
    scr_dyn_release(value);
    return result;
  }
  SpKey *object = sp_key_of(input);
  if (object) {
    if (private_key) {
      scr_dyn_arg_type_fail("key", sp_key_input_types, input);
      return NULL;
    }
    if (!object->private_key) {
      sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
               "Invalid key object type public, expected private.");
      return NULL;
    }
    SpKey *pub = sp_public_of(object);
    if (!pub) {
      sp_unsupported_input();
      return NULL;
    }
    return sp_key_box(pub);
  }
  const ScrDyn *data = input;
  const ScrDyn *format = scr_dyn_undefined();
  const ScrDyn *type = scr_dyn_undefined();
  const ScrDyn *encoding = NULL;
  if (sp_is_object(input) && !scr_buffer_storage_is(input)) {
    data = sp_opt(input, "key");
    format = sp_opt(input, "format");
    type = sp_opt(input, "type");
    encoding = sp_opt(input, "encoding");
    if (!sp_absent(sp_opt(input, "passphrase"))) {
      sp_not_supported("encrypted private keys");
      return NULL;
    }
    SpKey *inner = sp_key_of(data);
    if (inner) return sp_create_key((ScrDyn *)data, private_key);
    if (sp_is_str(format, "jwk")) {
      SpKey *k = sp_key_from_jwk(data, private_key);
      return k ? sp_key_box(k) : NULL;
    }
    if (!sp_absent(format) && !sp_is_str(format, "pem") && !sp_is_str(format, "der")) {
      sp_property_invalid("key.format", format);
      return NULL;
    }
    if (sp_is_str(format, "der")) {
      bool valid = private_key ? sp_is_str(type, "pkcs1") || sp_is_str(type, "pkcs8") ||
                                     sp_is_str(type, "sec1")
                               : sp_is_str(type, "pkcs1") || sp_is_str(type, "spki");
      if (!valid) {
        sp_property_invalid("key.type", type);
        return NULL;
      }
    }
  }
  ScrBytes *bytes = sp_source_bytes(data, encoding);
  if (!bytes) {
    if (data->kind == SCR_DYN_STR || data->kind == SCR_DYN_BYTES || scr_buffer_storage_is(data))
      return NULL; /* the decoder threw */
    scr_dyn_arg_type_fail(data == input ? "key" : "key.key", sp_key_input_types, data);
    return NULL;
  }
  SpKey *k = sp_parse(bytes->data, (size_t)scr_bytes_byte_len(bytes), private_key);
  scr_bytes_release(bytes);
  return k ? sp_key_box(k) : NULL;
}

ScrDyn *scr_crypto_create_private_key(ScrDyn *key) { return sp_create_key(key, true); }

ScrDyn *scr_crypto_create_public_key(ScrDyn *key) { return sp_create_key(key, false); }

/* ── export ───────────────────────────────────────────────────────────── */

/* export({ format, type }) per Node's parseKeyEncoding: format "pem",
 * "der" or "jwk"; type pkcs1/pkcs8/sec1 for private keys and pkcs1/spki
 * for public keys, where pkcs1 needs an RSA key and sec1 an EC key. */
static ScrDyn *sp_export_plain(SpKey *k, const ScrDyn *options);

static ScrDyn *sp_export(SpKey *k, const ScrDyn *options) {
  ScrDyn *plain = sp_plain(options);
  if (!plain) return NULL;
  ScrDyn *result = sp_export_plain(k, plain);
  scr_dyn_release(plain);
  return result;
}

static ScrDyn *sp_export_plain(SpKey *k, const ScrDyn *options) {
  if (options == NULL || !sp_is_object(options)) {
    scr_dyn_arg_type_fail("options", "of type object", options ? options : scr_dyn_undefined());
    return NULL;
  }
  const ScrDyn *format = sp_opt(options, "format");
  if (sp_is_str(format, "jwk")) return sp_export_jwk(k);
  bool pem = sp_is_str(format, "pem");
  if (!pem && !sp_is_str(format, "der")) {
    sp_property_invalid("options.format", format);
    return NULL;
  }
  const ScrDyn *type = sp_opt(options, "type");
  bool pkcs1 = sp_is_str(type, "pkcs1");
  bool pkcs8 = k->private_key && sp_is_str(type, "pkcs8");
  bool sec1 = k->private_key && sp_is_str(type, "sec1");
  bool spki = !k->private_key && sp_is_str(type, "spki");
  if (!pkcs1 && !pkcs8 && !sec1 && !spki) {
    sp_property_invalid("options.type", type);
    return NULL;
  }
  if (!sp_absent(sp_opt(options, "cipher")) || !sp_absent(sp_opt(options, "passphrase"))) {
    sp_not_supported("encrypted private key export");
    return NULL;
  }
  if (pkcs1 && !sp_is_rsa(k)) {
    sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS",
             "The selected key encoding pkcs1 can only be used for RSA keys.");
    return NULL;
  }
  if (sec1 && !sp_is_ec(k)) {
    sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS",
             "The selected key encoding sec1 can only be used for EC keys.");
    return NULL;
  }
  unsigned char *der = malloc(SP_DER_MAX);
  if (!der) scr_trap("scriptc: out of memory\n");
  int n;
  const char *label;
  if (pkcs8) {
    n = sp_write_pkcs8_der(k, der, SP_DER_MAX);
    label = "PRIVATE KEY";
  } else if (spki) {
    n = sp_write_spki_der(k, der, SP_DER_MAX);
    label = "PUBLIC KEY";
  } else if (k->private_key) {
    n = sp_write_private_der(k, der, SP_DER_MAX);
    label = pkcs1 ? "RSA PRIVATE KEY" : "EC PRIVATE KEY";
  } else {
    n = sp_write_pkcs1_public_der(k, der, SP_DER_MAX);
    label = "RSA PUBLIC KEY";
  }
  ScrDyn *result = NULL;
  if (n < 0) {
    sp_unsupported_input();
  } else {
    const unsigned char *start = der + SP_DER_MAX - n;
    result = pem ? sp_dyn_str(sp_pem(label, start, (size_t)n)) : sp_dyn_buffer(start, (size_t)n);
  }
  mbedtls_platform_zeroize(der, SP_DER_MAX);
  free(der);
  return result;
}

/* ── the KeyObject handles ────────────────────────────────────────────── */

static ScrDyn *sp_key_details(SpKey *k) {
  ScrDyn *details = scr_dyn_new_obj();
  if (sp_is_ed(k)) return details;
  if (sp_is_rsa(k)) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(k->pk);
    mbedtls_mpi e;
    mbedtls_mpi_init(&e);
    mbedtls_rsa_export(rsa, NULL, NULL, NULL, NULL, &e);
    uint64_t exponent = 0;
    size_t bytes = mbedtls_mpi_size(&e);
    unsigned char raw[8] = {0};
    if (bytes <= 8) mbedtls_mpi_write_binary(&e, raw, 8);
    for (size_t i = 0; i < 8; i++) exponent = (exponent << 8) | raw[i];
    mbedtls_mpi_free(&e);
    sp_set(details, "modulusLength", scr_dyn_new_num((double)mbedtls_pk_get_bitlen(&k->pk)));
    ScrBigInt *big = scr_bigint_from_u64(exponent);
    sp_set(details, "publicExponent", scr_dyn_new_bigint(big));
    scr_bigint_release(big);
  } else {
    const SpCurve *curve = sp_curve_of(k);
    sp_set(details, "namedCurve", sp_dyn_str(scr_str_new(curve->name, strlen(curve->name))));
  }
  return details;
}

/* The DER that identifies a key for equals(): its private encoding for a
 * private key, its SubjectPublicKeyInfo otherwise. */
static int sp_identity_der(SpKey *k, unsigned char *buf, size_t size) {
  if (sp_is_ed(k)) return k->private_key ? sp_write_pkcs8_der(k, buf, size) : sp_write_spki_der(k, buf, size);
  return k->private_key ? sp_write_private_der(k, buf, size) : sp_write_spki_der(k, buf, size);
}

static ScrDyn *sp_key_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what) {
  (void)self;
  SpKey *k = h;
  if (strcmp(method, "export") == 0) return sp_export(k, argc ? args[0] : NULL);
  if (strcmp(method, "equals") == 0) {
    const ScrDyn *other_value = argc ? args[0] : scr_dyn_undefined();
    SpKey *other = sp_key_of(other_value);
    if (!other) {
      size_t len;
      if (scr_key_object_bytes(other_value, &len)) return scr_dyn_new_bool(false);
      scr_dyn_arg_type_fail("otherKeyObject", "an instance of KeyObject", other_value);
      return NULL;
    }
    if (other->private_key != k->private_key ||
        mbedtls_pk_get_type(&other->pk) != mbedtls_pk_get_type(&k->pk))
      return scr_dyn_new_bool(false);
    unsigned char *a = malloc(SP_DER_MAX), *b = malloc(SP_DER_MAX);
    if (!a || !b) scr_trap("scriptc: out of memory\n");
    int na = sp_identity_der(k, a, SP_DER_MAX);
    int nb = sp_identity_der(other, b, SP_DER_MAX);
    bool same = na > 0 && na == nb && memcmp(a + SP_DER_MAX - na, b + SP_DER_MAX - nb, (size_t)na) == 0;
    mbedtls_platform_zeroize(a, SP_DER_MAX);
    mbedtls_platform_zeroize(b, SP_DER_MAX);
    free(a);
    free(b);
    return scr_dyn_new_bool(same);
  }
  if (strcmp(method, "toCryptoKey") == 0) {
    sp_not_supported("KeyObject.toCryptoKey");
    return NULL;
  }
  scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "%s is not a function", what);
  return NULL;
}

static ScrDyn *sp_key_get(void *h, const char *name, size_t len) {
  SpKey *k = h;
  if (len == 4 && memcmp(name, "type", 4) == 0)
    return k->private_key ? sp_dyn_str(scr_str_new("private", 7)) : sp_dyn_str(scr_str_new("public", 6));
  if (len == 17 && memcmp(name, "asymmetricKeyType", 17) == 0)
    return sp_is_ed(k)    ? sp_dyn_str(scr_str_new("ed25519", 7))
           : sp_is_rsa(k) ? sp_dyn_str(scr_str_new("rsa", 3))
                          : sp_dyn_str(scr_str_new("ec", 2));
  if (len == 20 && memcmp(name, "asymmetricKeyDetails", 20) == 0) return sp_key_details(k);
  return NULL;
}

static bool sp_key_set(void *h, const char *name, size_t len, const ScrDyn *value) {
  (void)h;
  (void)value;
  const char *holder = len == 4 && memcmp(name, "type", 4) == 0 ? "KeyObject"
                       : (len == 17 && memcmp(name, "asymmetricKeyType", 17) == 0) ||
                               (len == 20 && memcmp(name, "asymmetricKeyDetails", 20) == 0)
                           ? "AsymmetricKeyObject"
                           : NULL;
  if (!holder) return false;
  scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "Cannot set property %.*s of #<%s> which has only a getter", (int)len, name,
                    holder);
  return true;
}

static ScrDyn *sp_key_inspect_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

static const ScrDynHandleOps sp_private_ops = {
    .cls = "PrivateKeyObject",
    .retain = sp_key_retain,
    .release = sp_key_release,
    .invoke = sp_key_invoke,
    .get = sp_key_get,
    .set = sp_key_set,
    .inspect_view = sp_key_inspect_view,
    .json_empty_object = true,
    .to_string_tag = "KeyObject",
    .inspect_view_empty = true,
};

static const ScrDynHandleOps sp_public_ops = {
    .cls = "PublicKeyObject",
    .retain = sp_key_retain,
    .release = sp_key_release,
    .invoke = sp_key_invoke,
    .get = sp_key_get,
    .set = sp_key_set,
    .inspect_view = sp_key_inspect_view,
    .json_empty_object = true,
    .to_string_tag = "KeyObject",
    .inspect_view_empty = true,
};

/* createHmac with a private or public key (scr_crypto_reject_asymmetric_secret). */
static void sp_reject_as_secret(const ScrDyn *key) {
  bool private_key = key->v.handle.tag == SCR_DYNH_PRIVATE_KEY;
  scr_throw_error_msg_code(SCR_ERR_TYPE,
                           private_key ? "Invalid key object type private, expected secret."
                                       : "Invalid key object type public, expected secret.",
                           private_key ? 49 : 48, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
}

static void sp_key_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_PRIVATE_KEY, &sp_private_ops);
  scr_dyn_handle_install(SCR_DYNH_PUBLIC_KEY, &sp_public_ops);
  scr_crypto_reject_asymmetric_secret = sp_reject_as_secret;
}

/* ── generateKeyPairSync ──────────────────────────────────────────────── */

/* A key in the encoding an options.publicKeyEncoding/privateKeyEncoding
 * object asks for, or the KeyObject when it is undefined. Consumes `k`. */
static ScrDyn *sp_encoded(SpKey *k, const ScrDyn *encoding) {
  if (sp_absent(encoding)) return sp_key_box(k);
  ScrDyn *result = sp_export(k, encoding);
  sp_key_release(k);
  return result;
}

static bool sp_check_encoding_plain(const ScrDyn *encoding, const char *name, bool private_key);

static bool sp_check_encoding(const ScrDyn *options, const char *name, bool private_key) {
  ScrDyn *encoding = sp_plain(sp_opt(options, name));
  if (!encoding) return false;
  bool ok = sp_check_encoding_plain(encoding, name, private_key);
  scr_dyn_release(encoding);
  return ok;
}

static bool sp_check_encoding_plain(const ScrDyn *encoding, const char *name, bool private_key) {
  if (sp_absent(encoding)) return true;
  char full[64];
  snprintf(full, sizeof full, "options.%s", name);
  if (!sp_is_object(encoding)) {
    sp_property_invalid(full, encoding);
    return false;
  }
  const ScrDyn *format = sp_opt(encoding, "format");
  if (!sp_is_str(format, "pem") && !sp_is_str(format, "der") && !sp_is_str(format, "jwk")) {
    snprintf(full, sizeof full, "options.%s.format", name);
    sp_property_invalid(full, format);
    return false;
  }
  if (sp_is_str(format, "jwk")) return true;
  const ScrDyn *type = sp_opt(encoding, "type");
  bool valid = private_key ? sp_is_str(type, "pkcs1") || sp_is_str(type, "pkcs8") || sp_is_str(type, "sec1")
                           : sp_is_str(type, "pkcs1") || sp_is_str(type, "spki");
  if (!valid) {
    snprintf(full, sizeof full, "options.%s.type", name);
    sp_property_invalid(full, type);
    return false;
  }
  return true;
}

/* Generates the private key for (type, options), validated in Node's
 * order; NULL with the error pending. */
static SpKey *sp_generate(const ScrDyn *type, const ScrDyn *options) {
  if (type->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("type", "of type string", type);
    return NULL;
  }
  bool rsa = sp_is_str(type, "rsa");
  bool ec = sp_is_str(type, "ec");
  bool ed = sp_is_str(type, "ed25519");
  static const char *const known[] = {"rsa-pss", "dsa", "ed448", "x25519", "x448", "dh"};
  bool other = false;
  for (size_t i = 0; i < sizeof known / sizeof known[0]; i++) other = other || sp_is_str(type, known[i]);
  if (!rsa && !ec && !ed && !other) {
    ScrStr *received = sp_received(type, false);
    scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE",
                      "The argument 'type' must be a supported key type. Received %.*s", (int)received->len,
                      received->data);
    scr_str_release(received);
    return NULL;
  }
  /* The ed25519 options are optional. */
  if (!sp_is_object(options) && !(ed && sp_absent(options))) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  if (other) {
    sp_not_supported("generateKeyPairSync for this key type");
    return NULL;
  }
  SpKey *k = sp_key_alloc(true);
  if (ed) {
    if (!sp_check_encoding(options, "publicKeyEncoding", false) ||
        !sp_check_encoding(options, "privateKeyEncoding", true)) {
      sp_key_release(k);
      return NULL;
    }
    const ScrPkiEd25519 *ed = sp_ed();
    if (!ed) {
      sp_key_release(k);
      return NULL;
    }
    k->ed25519 = true;
    sp_random(NULL, k->ed_seed, 32);
    ed->public_key(k->ed_pub, k->ed_seed);
    return k;
  }
  if (rsa) {
    const ScrDyn *bits = sp_opt(options, "modulusLength");
    if (bits->kind != SCR_DYN_NUM) {
      sp_key_release(k);
      scr_dyn_prop_type_fail("options.modulusLength", "of type number", bits);
      return NULL;
    }
    double b = bits->v.num;
    /* validateUint32: an integer first, then the range. */
    bool integer = isfinite(b) && trunc(b) == b;
    if (!integer || b < 0 || b > 4294967295.0) {
      sp_key_release(k);
      ScrStr *received = sp_received(bits, true);
      scr_pki_throw_fmt(SCR_ERR_RANGE, "ERR_OUT_OF_RANGE",
                        "The value of \"options.modulusLength\" is out of range. It must be %s. Received %.*s",
                        integer ? ">= 0 && <= 4294967295" : "an integer", (int)received->len, received->data);
      scr_str_release(received);
      return NULL;
    }
    const ScrDyn *exp = sp_opt(options, "publicExponent");
    double e = 65537;
    if (!sp_absent(exp)) {
      if (exp->kind != SCR_DYN_NUM) {
        sp_key_release(k);
        scr_dyn_prop_type_fail("options.publicExponent", "of type number", exp);
        return NULL;
      }
      e = exp->v.num;
    }
    if (!sp_check_encoding(options, "publicKeyEncoding", false) ||
        !sp_check_encoding(options, "privateKeyEncoding", true)) {
      sp_key_release(k);
      return NULL;
    }
    if (b < 512 || b > 16384 || e < 3 || e > 2147483647.0 || e != (double)(int64_t)e || ((int64_t)e & 1) == 0 ||
        mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) != 0 ||
        mbedtls_rsa_gen_key(mbedtls_pk_rsa(k->pk), sp_random, NULL, (unsigned)b, (int)e) != 0) {
      sp_key_release(k);
      sp_not_supported("generateKeyPairSync with this RSA modulus length or exponent");
      return NULL;
    }
    return k;
  }
  const ScrDyn *curve_name = sp_opt(options, "namedCurve");
  if (curve_name->kind != SCR_DYN_STR) {
    sp_key_release(k);
    scr_dyn_prop_type_fail("options.namedCurve", "of type string", curve_name);
    return NULL;
  }
  if (!sp_check_encoding(options, "publicKeyEncoding", false) ||
      !sp_check_encoding(options, "privateKeyEncoding", true)) {
    sp_key_release(k);
    return NULL;
  }
  const SpCurve *curve = NULL;
  for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
    if (sp_is_str(curve_name, sp_curves[i].name) ||
        (sp_curves[i].nist && sp_is_str(curve_name, sp_curves[i].nist)))
      curve = &sp_curves[i];
  if (!curve) {
    sp_key_release(k);
    sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
    return NULL;
  }
  if (mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) != 0 ||
      mbedtls_ecp_gen_key(curve->id, mbedtls_pk_ec(k->pk), sp_random, NULL) != 0) {
    sp_key_release(k);
    sp_unsupported_input();
    return NULL;
  }
  return k;
}

/* generateKeyPairSync(type, options): { publicKey, privateKey }, each a
 * KeyObject or the encoding the options ask for. */
ScrDyn *scr_crypto_generate_key_pair_sync(ScrDyn *type, ScrDyn *options) {
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(options);
    if (!value) return NULL;
    ScrDyn *result = scr_crypto_generate_key_pair_sync(type, value);
    scr_dyn_release(value);
    return result;
  }
  SpKey *k = sp_generate(type, options);
  if (!k) return NULL;
  SpKey *pub = sp_public_of(k);
  if (!pub) {
    sp_key_release(k);
    sp_unsupported_input();
    return NULL;
  }
  ScrDyn *public_value = sp_encoded(pub, sp_opt(options, "publicKeyEncoding"));
  if (!public_value) {
    sp_key_release(k);
    return NULL;
  }
  ScrDyn *private_value = sp_encoded(k, sp_opt(options, "privateKeyEncoding"));
  if (!private_value) {
    scr_dyn_release(public_value);
    return NULL;
  }
  ScrDyn *pair = scr_dyn_new_obj();
  sp_set(pair, "publicKey", public_value);
  sp_set(pair, "privateKey", private_value);
  return pair;
}

/* ── sign and verify ──────────────────────────────────────────────────── */

typedef struct {
  const char *name;
  mbedtls_md_type_t md;
} SpDigest;

/* Digest names as OpenSSL's EVP_get_digestbyname takes them for
 * signatures, matched without regard to case. */
static const SpDigest sp_digests[] = {
    {"sha1", MBEDTLS_MD_SHA1},           {"rsa-sha1", MBEDTLS_MD_SHA1},
    {"sha1withrsaencryption", MBEDTLS_MD_SHA1}, {"ecdsa-with-sha1", MBEDTLS_MD_SHA1},
    {"sha224", MBEDTLS_MD_SHA224},       {"rsa-sha224", MBEDTLS_MD_SHA224},
    {"sha224withrsaencryption", MBEDTLS_MD_SHA224},
    {"sha256", MBEDTLS_MD_SHA256},       {"rsa-sha256", MBEDTLS_MD_SHA256},
    {"sha256withrsaencryption", MBEDTLS_MD_SHA256},
    {"sha384", MBEDTLS_MD_SHA384},       {"rsa-sha384", MBEDTLS_MD_SHA384},
    {"sha384withrsaencryption", MBEDTLS_MD_SHA384},
    {"sha512", MBEDTLS_MD_SHA512},       {"rsa-sha512", MBEDTLS_MD_SHA512},
    {"sha512withrsaencryption", MBEDTLS_MD_SHA512},
    {"sha2-256", MBEDTLS_MD_SHA256},     {"sha2-384", MBEDTLS_MD_SHA384},
    {"sha2-512", MBEDTLS_MD_SHA512},     {"sha2-224", MBEDTLS_MD_SHA224},
};

static bool sp_digest_of(const ScrStr *name, mbedtls_md_type_t *md) {
  for (size_t i = 0; i < sizeof sp_digests / sizeof sp_digests[0]; i++) {
    size_t n = strlen(sp_digests[i].name);
    if (name->len != n) continue;
    bool same = true;
    for (size_t j = 0; j < n && same; j++) {
      char c = name->data[j];
      if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
      same = c == sp_digests[i].name[j];
    }
    if (same) {
      *md = sp_digests[i].md;
      return true;
    }
  }
  return false;
}

/* The algorithm argument of crypto.sign/verify: a digest name, or
 * null/undefined for the key type's default (SHA-256). */
static bool sp_algorithm(const ScrDyn *alg, mbedtls_md_type_t *md) {
  if (alg->kind == SCR_DYN_UNDEF || alg->kind == SCR_DYN_NULL) {
    *md = MBEDTLS_MD_SHA256;
    return true;
  }
  if (alg->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("algorithm", "of type string", alg);
    return false;
  }
  if (!sp_digest_of(alg->v.str, md)) {
    /* The whole name, at any length and with any bytes, as in Node. */
    static const char prefix[] = "Invalid digest: ";
    size_t len = sizeof prefix - 1 + alg->v.str->len;
    char *message = malloc(len);
    if (!message) scr_trap("scriptc: out of memory\n");
    memcpy(message, prefix, sizeof prefix - 1);
    memcpy(message + sizeof prefix - 1, alg->v.str->data, alg->v.str->len);
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, len, "ERR_CRYPTO_INVALID_DIGEST");
    free(message);
    return false;
  }
  return true;
}

typedef struct {
  SpKey *key;   /* +1 */
  int padding;  /* RSA_PKCS1_PADDING (1) or RSA_PKCS1_PSS_PADDING (6) */
  int salt;     /* -1 digest length, -2 maximum (sign) or auto (verify) */
  bool p1363;   /* dsaEncoding: "ieee-p1363" */
} SpSigKey;

/* The key argument of a signing operation: a KeyObject, key material, or
 * { key, dsaEncoding, padding, saltLength, ...createKey options }. */
static bool sp_sig_key_plain(const ScrDyn *value, bool sign, SpSigKey *out);

static bool sp_sig_key(const ScrDyn *value, bool sign, SpSigKey *out) {
  out->key = NULL;
  ScrDyn *plain = sp_plain(value);
  if (!plain) return false;
  bool ok = sp_sig_key_plain(plain, sign, out);
  scr_dyn_release(plain);
  return ok;
}

static bool sp_sig_key_plain(const ScrDyn *value, bool sign, SpSigKey *out) {
  out->key = NULL;
  out->padding = 1;
  out->salt = sign ? -2 : -2;
  out->p1363 = false;
  const ScrDyn *options = NULL;
  if (sp_is_object(value) && !sp_key_of(value) && !scr_buffer_storage_is(value)) {
    options = value;
    const ScrDyn *dsa = sp_opt(value, "dsaEncoding");
    if (sp_is_str(dsa, "ieee-p1363")) out->p1363 = true;
    else if (!sp_absent(dsa) && !sp_is_str(dsa, "der")) {
      sp_property_invalid("options.dsaEncoding", dsa);
      return false;
    }
    const ScrDyn *padding = sp_opt(value, "padding");
    if (!sp_absent(padding)) {
      if (padding->kind != SCR_DYN_NUM || (padding->v.num != 1 && padding->v.num != 6)) {
        sp_not_supported("signatures with this padding");
        return false;
      }
      out->padding = (int)padding->v.num;
    }
    const ScrDyn *salt = sp_opt(value, "saltLength");
    if (!sp_absent(salt)) {
      if (salt->kind != SCR_DYN_NUM || salt->v.num != (double)(int)salt->v.num || salt->v.num < -2) {
        sp_not_supported("signatures with this saltLength");
        return false;
      }
      out->salt = (int)salt->v.num;
    }
  }
  SpKey *direct = sp_key_of(options ? sp_opt(options, "key") : value);
  if (direct) {
    if (sign && !direct->private_key) {
      sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
               "Invalid key object type public, expected private.");
      return false;
    }
    sp_key_retain(direct);
    out->key = direct;
    return true;
  }
  ScrDyn *created = sp_create_key((ScrDyn *)value, sign);
  if (!created) return false;
  out->key = sp_key_retain(sp_key_of(created));
  scr_dyn_release(created);
  return true;
}

/* DER ECDSA-Sig-Value ⇄ IEEE P1363 r || s. */
static bool sp_der_to_p1363(const unsigned char *der, size_t len, size_t size, unsigned char *out) {
  unsigned char *p = (unsigned char *)der;
  const unsigned char *end = der + len;
  size_t seq;
  mbedtls_mpi r, s;
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  bool ok = mbedtls_asn1_get_tag(&p, end, &seq, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) == 0 &&
            mbedtls_asn1_get_mpi(&p, end, &r) == 0 && mbedtls_asn1_get_mpi(&p, end, &s) == 0 &&
            mbedtls_mpi_write_binary(&r, out, size) == 0 &&
            mbedtls_mpi_write_binary(&s, out + size, size) == 0;
  mbedtls_mpi_free(&r);
  mbedtls_mpi_free(&s);
  return ok;
}

static int sp_p1363_to_der(const unsigned char *sig, size_t len, unsigned char *buf, size_t size) {
  mbedtls_mpi r, s;
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  int out = -1;
  if (len % 2 == 0 && mbedtls_mpi_read_binary(&r, sig, len / 2) == 0 &&
      mbedtls_mpi_read_binary(&s, sig + len / 2, len / 2) == 0) {
    unsigned char *c = buf + size;
    size_t n = 0;
    int w;
    if ((w = mbedtls_asn1_write_mpi(&c, buf, &s)) >= 0) {
      n += (size_t)w;
      if ((w = mbedtls_asn1_write_mpi(&c, buf, &r)) >= 0) {
        n += (size_t)w;
        if ((w = mbedtls_asn1_write_len(&c, buf, n)) >= 0) {
          n += (size_t)w;
          if ((w = mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) >= 0)
            out = (int)(n + (size_t)w);
        }
      }
    }
  }
  mbedtls_mpi_free(&r);
  mbedtls_mpi_free(&s);
  return out;
}

static size_t sp_ec_size(SpKey *k) { return (mbedtls_pk_ec(k->pk)->MBEDTLS_PRIVATE(grp).nbits + 7) / 8; }

/* Applies the RSA padding of a signature operation. */
static bool sp_rsa_padding(SpSigKey *key, mbedtls_md_type_t md) {
  if (!sp_is_rsa(key->key)) return true;
  mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
  if (key->padding == 6) return mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, md) == 0;
  return mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V15, MBEDTLS_MD_NONE) == 0;
}

/* Signs a digest: +1 Buffer or NULL with the error pending. */
static ScrDyn *sp_sign_hash(SpSigKey *key, mbedtls_md_type_t md, const unsigned char *hash, size_t hash_len) {
  unsigned char sig[MBEDTLS_PK_SIGNATURE_MAX_SIZE];
  size_t sig_len = 0;
  int r;
  if (!sp_rsa_padding(key, md)) {
    sp_unsupported_input();
    return NULL;
  }
  if (sp_is_rsa(key->key) && key->padding == 6) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
    int salt = key->salt;
    size_t bytes = mbedtls_rsa_get_len(rsa);
    size_t bits = mbedtls_pk_get_bitlen(&key->key->pk);
    size_t max = bytes - hash_len - 2 - ((bits - 1) % 8 == 0 ? 1 : 0);
    if (salt == -1) salt = (int)hash_len;
    else if (salt == -2) salt = (int)max;
    if (salt < 0 || (size_t)salt > max) {
      sp_throw(SCR_ERR_ERROR, "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE",
               "error:1C8000A5:Provider routines::data too large for key size");
      return NULL;
    }
    r = mbedtls_rsa_rsassa_pss_sign_ext(rsa, sp_random, NULL, md, (unsigned)hash_len, hash, salt, sig);
    sig_len = bytes;
  } else {
    r = mbedtls_pk_sign(&key->key->pk, md, hash, hash_len, sig, sizeof sig, &sig_len, sp_random, NULL);
  }
  if (r != 0) {
    sp_unsupported_input();
    return NULL;
  }
  if (sp_is_ec(key->key) && key->p1363) {
    size_t size = sp_ec_size(key->key);
    unsigned char raw[2 * 66];
    if (!sp_der_to_p1363(sig, sig_len, size, raw)) {
      sp_unsupported_input();
      return NULL;
    }
    return sp_dyn_buffer(raw, 2 * size);
  }
  return sp_dyn_buffer(sig, sig_len);
}

/* Verifies a digest against a signature; false for a signature that does
 * not verify or does not parse. */
static bool sp_verify_hash(SpSigKey *key, mbedtls_md_type_t md, const unsigned char *hash, size_t hash_len,
                           const unsigned char *sig, size_t sig_len) {
  if (!sp_rsa_padding(key, md)) return false;
  if (sp_is_rsa(key->key) && key->padding == 6) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
    if (sig_len != mbedtls_rsa_get_len(rsa)) return false;
    int salt = key->salt;
    if (salt == -1) salt = (int)hash_len;
    else if (salt == -2) salt = MBEDTLS_RSA_SALT_LEN_ANY;
    return mbedtls_rsa_rsassa_pss_verify_ext(rsa, md, (unsigned)hash_len, hash, md, salt, sig) == 0;
  }
  if (sp_is_ec(key->key) && key->p1363) {
    unsigned char der[2 * 66 + 16];
    if (sig_len != 2 * sp_ec_size(key->key)) return false;
    int n = sp_p1363_to_der(sig, sig_len, der, sizeof der);
    if (n < 0) return false;
    return mbedtls_pk_verify(&key->key->pk, md, hash, hash_len, der + sizeof der - n, (size_t)n) == 0;
  }
  return mbedtls_pk_verify(&key->key->pk, md, hash, hash_len, sig, sig_len) == 0;
}

static const char sp_data_types[] = "an instance of Buffer, TypedArray, or DataView";

/* Ed25519 signs the message itself: an algorithm other than null or
 * undefined is OpenSSL's invalid digest (false, error pending). */
static bool sp_ed_digest_given(const ScrDyn *algorithm) {
  if (algorithm->kind == SCR_DYN_UNDEF || algorithm->kind == SCR_DYN_NULL) return true;
  sp_throw(SCR_ERR_ERROR, "ERR_OSSL_INVALID_DIGEST", "error:1C80007A:Provider routines::invalid digest");
  return false;
}

/* crypto.sign(algorithm, data, key): the signature Buffer. */
ScrDyn *scr_crypto_sign_oneshot(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key) {
  mbedtls_md_type_t md;
  if (!sp_algorithm(algorithm, &md)) return NULL;
  if (data->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("data", sp_data_types, data);
    return NULL;
  }
  SpSigKey k;
  if (!sp_sig_key(key, true, &k)) return NULL;
  ScrBytes *bytes = scr_bytes_buffer_source(data);
  if (sp_is_ed(k.key)) {
    ScrDyn *result = NULL;
    const ScrPkiEd25519 *ed = sp_ed_digest_given(algorithm) ? sp_ed() : NULL;
    if (ed) {
      uint8_t sig[64];
      ed->sign(sig, k.key->ed_seed, k.key->ed_pub, bytes->data, (size_t)scr_bytes_byte_len(bytes));
      result = sp_dyn_buffer(sig, 64);
    }
    scr_bytes_release(bytes);
    sp_key_release(k.key);
    return result;
  }
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
  mbedtls_md(info, bytes->data, (size_t)scr_bytes_byte_len(bytes), hash);
  scr_bytes_release(bytes);
  ScrDyn *result = sp_sign_hash(&k, md, hash, mbedtls_md_get_size(info));
  sp_key_release(k.key);
  return result;
}

/* crypto.verify(algorithm, data, key, signature): a boolean. */
ScrDyn *scr_crypto_verify_oneshot(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key, ScrDyn *signature) {
  mbedtls_md_type_t md;
  if (!sp_algorithm(algorithm, &md)) return NULL;
  if (data->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("data", sp_data_types, data);
    return NULL;
  }
  SpSigKey k;
  if (!sp_sig_key(key, false, &k)) return NULL;
  if (signature->kind != SCR_DYN_BYTES) {
    sp_key_release(k.key);
    scr_dyn_arg_type_fail("signature", sp_data_types, signature);
    return NULL;
  }
  ScrBytes *bytes = scr_bytes_buffer_source(data);
  ScrBytes *sig = scr_bytes_buffer_source(signature);
  if (sp_is_ed(k.key)) {
    ScrDyn *result = NULL;
    const ScrPkiEd25519 *ed = sp_ed_digest_given(algorithm) ? sp_ed() : NULL;
    if (ed)
      result = scr_dyn_new_bool(sp_ed_verify(ed, k.key->ed_pub, bytes->data,
                                             (size_t)scr_bytes_byte_len(bytes), sig->data,
                                             (size_t)scr_bytes_byte_len(sig)));
    scr_bytes_release(bytes);
    scr_bytes_release(sig);
    sp_key_release(k.key);
    return result;
  }
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
  mbedtls_md(info, bytes->data, (size_t)scr_bytes_byte_len(bytes), hash);
  bool ok = sp_verify_hash(&k, md, hash, mbedtls_md_get_size(info), sig->data, (size_t)scr_bytes_byte_len(sig));
  scr_bytes_release(bytes);
  scr_bytes_release(sig);
  sp_key_release(k.key);
  return scr_dyn_new_bool(ok);
}

/* ── Sign and Verify objects ──────────────────────────────────────────── */

typedef struct SpSigner {
  size_t rc;
  mbedtls_md_context_t md;
  mbedtls_md_type_t type;
  bool done; /* sign()/verify() ran: Node's "Not initialised" afterwards */
} SpSigner;

static void *sp_signer_retain(void *h) {
  ((SpSigner *)h)->rc++;
  return h;
}

static void sp_signer_release(void *h) {
  SpSigner *s = h;
  if (--s->rc) return;
  mbedtls_md_free(&s->md);
  free(s);
}

static void sp_not_initialised(void) {
  sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INVALID_STATE", "Not initialised");
}

/* update(data[, inputEncoding]): strings encode with the encoding (UTF-8
 * by default). */
static bool sp_signer_update(SpSigner *s, ScrDyn *const *args, size_t argc) {
  if (s->done) {
    sp_not_initialised();
    return false;
  }
  const ScrDyn *data = argc ? args[0] : scr_dyn_undefined();
  if (data->kind != SCR_DYN_STR && data->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
    return false;
  }
  ScrBytes *bytes = sp_source_bytes(data, argc > 1 ? args[1] : NULL);
  if (!bytes) return false;
  mbedtls_md_update(&s->md, bytes->data, (size_t)scr_bytes_byte_len(bytes));
  scr_bytes_release(bytes);
  return true;
}

/* An output or signature encoding argument: a string encoding, or the
 * Buffer form for undefined, null and "buffer". */
static const ScrStr *sp_encoding_arg(const ScrDyn *v) {
  if (v == NULL || v->kind != SCR_DYN_STR || sp_is_str(v, "buffer")) return NULL;
  return v->v.str;
}

static ScrDyn *sp_signer_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what, bool verifier) {
  SpSigner *s = h;
  if (strcmp(method, "update") == 0) return sp_signer_update(s, args, argc) ? scr_dyn_retain(self) : NULL;
  if (!verifier && strcmp(method, "sign") == 0) {
    if (s->done) {
      sp_not_initialised();
      return NULL;
    }
    SpSigKey k;
    if (!sp_sig_key(argc ? args[0] : scr_dyn_undefined(), true, &k)) return NULL;
    if (sp_is_ed(k.key)) {
      sp_key_release(k.key);
      sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
      return NULL;
    }
    unsigned char hash[MBEDTLS_MD_MAX_SIZE];
    mbedtls_md_finish(&s->md, hash);
    s->done = true;
    ScrDyn *sig = sp_sign_hash(&k, s->type, hash, mbedtls_md_get_size(mbedtls_md_info_from_type(s->type)));
    sp_key_release(k.key);
    const ScrStr *encoding = sp_encoding_arg(argc > 1 ? args[1] : NULL);
    if (!sig || !encoding) return sig;
    ScrBytes *bytes = scr_bytes_buffer_source(sig);
    ScrStr *text = scr_bytes_to_str_checked(bytes, encoding);
    scr_bytes_release(bytes);
    scr_dyn_release(sig);
    return text ? sp_dyn_str(text) : NULL;
  }
  if (verifier && strcmp(method, "verify") == 0) {
    if (s->done) {
      sp_not_initialised();
      return NULL;
    }
    SpSigKey k;
    if (!sp_sig_key(argc ? args[0] : scr_dyn_undefined(), false, &k)) return NULL;
    if (sp_is_ed(k.key)) {
      sp_key_release(k.key);
      sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
      return NULL;
    }
    const ScrDyn *signature = argc > 1 ? args[1] : scr_dyn_undefined();
    if (signature->kind != SCR_DYN_STR && signature->kind != SCR_DYN_BYTES) {
      sp_key_release(k.key);
      scr_dyn_arg_type_fail("signature", "of type string or an instance of Buffer, TypedArray, or DataView",
                            signature);
      return NULL;
    }
    const ScrStr *encoding = sp_encoding_arg(argc > 2 ? args[2] : NULL);
    ScrDyn *encoding_value = encoding ? scr_dyn_new_str((ScrStr *)encoding) : NULL;
    ScrBytes *sig = sp_source_bytes(signature, encoding_value);
    if (encoding_value) scr_dyn_release(encoding_value);
    if (!sig) {
      sp_key_release(k.key);
      return NULL;
    }
    unsigned char hash[MBEDTLS_MD_MAX_SIZE];
    mbedtls_md_finish(&s->md, hash);
    s->done = true;
    bool ok = sp_verify_hash(&k, s->type, hash, mbedtls_md_get_size(mbedtls_md_info_from_type(s->type)),
                             sig->data, (size_t)scr_bytes_byte_len(sig));
    scr_bytes_release(sig);
    sp_key_release(k.key);
    return scr_dyn_new_bool(ok);
  }
  scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "%s is not a function", what);
  return NULL;
}

static ScrDyn *sp_sign_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                              const char *what) {
  return sp_signer_invoke(h, self, method, args, argc, what, false);
}

static ScrDyn *sp_verify_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what) {
  return sp_signer_invoke(h, self, method, args, argc, what, true);
}

/* Sign and Verify have no modeled properties. */
static ScrDyn *sp_signer_get(void *h, const char *name, size_t len) {
  (void)h;
  (void)name;
  (void)len;
  return NULL;
}

static bool sp_signer_set(void *h, const char *name, size_t len, const ScrDyn *value) {
  (void)h;
  (void)name;
  (void)len;
  (void)value;
  return false;
}

static ScrDyn *sp_signer_inspect_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

static const ScrDynHandleOps sp_sign_ops = {
    .cls = "Sign",
    .retain = sp_signer_retain,
    .release = sp_signer_release,
    .invoke = sp_sign_invoke,
    .get = sp_signer_get,
    .set = sp_signer_set,
    .inspect_view = sp_signer_inspect_view,
};

static const ScrDynHandleOps sp_verify_ops = {
    .cls = "Verify",
    .retain = sp_signer_retain,
    .release = sp_signer_release,
    .invoke = sp_verify_invoke,
    .get = sp_signer_get,
    .set = sp_signer_set,
    .inspect_view = sp_signer_inspect_view,
};

/* createSign(algorithm) / createVerify(algorithm). */
static ScrDyn *sp_signer_new(ScrDyn *algorithm, bool verifier) {
  if (algorithm->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("algorithm", "of type string", algorithm);
    return NULL;
  }
  mbedtls_md_type_t md;
  if (!sp_digest_of(algorithm->v.str, &md)) {
    sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_DIGEST", "Invalid digest");
    return NULL;
  }
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_SIGN, &sp_sign_ops);
    scr_dyn_handle_install(SCR_DYNH_VERIFY, &sp_verify_ops);
  }
  SpSigner *s = calloc(1, sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  s->rc = 1;
  s->type = md;
  mbedtls_md_init(&s->md);
  mbedtls_md_setup(&s->md, mbedtls_md_info_from_type(md), 0);
  mbedtls_md_starts(&s->md);
  ScrDyn *box = scr_dyn_new_handle(s, verifier ? SCR_DYNH_VERIFY : SCR_DYNH_SIGN);
  sp_signer_release(s);
  return box;
}

ScrDyn *scr_crypto_create_sign(ScrDyn *algorithm) { return sp_signer_new(algorithm, false); }

ScrDyn *scr_crypto_create_verify(ScrDyn *algorithm) { return sp_signer_new(algorithm, true); }

/* ── generateKeyPair ──────────────────────────────────────────────────── */

static ScrDyn *sp_cap(ScrClosure *c, size_t i) { return scr_box_get_ref(c->caps[i]); }

static void sp_key_pair_deliver(ScrClosure *self) {
  ScrDyn *callback = sp_cap(self, 0);
  ScrDyn *pair = sp_cap(self, 1);
  ScrDyn *args[3] = {scr_dyn_new_null(), scr_dyn_retain(scr_dyn_obj_get(pair, "publicKey", 9)),
                     scr_dyn_retain(scr_dyn_obj_get(pair, "privateKey", 10))};
  ScrDyn *result = scr_dyn_call(callback, args, 3, "callback");
  if (result) scr_dyn_release(result);
  for (size_t i = 0; i < 3; i++) scr_dyn_release(args[i]);
  scr_dyn_release(pair);
  scr_dyn_release(callback);
}

/* generateKeyPair(type, options, callback): argument errors throw, and the
 * callback receives (null, publicKey, privateKey) in a later macrotask. */
void scr_crypto_generate_key_pair_async(ScrDyn *type, ScrDyn *options, ScrDyn *callback) {
  ScrDyn *pair = scr_crypto_generate_key_pair_sync(type, options);
  if (!pair) return;
  ScrClosure *c = scr_closure_new((void *)sp_key_pair_deliver, 2);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_dyn_retain(callback));
  c->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[1], pair);
  scr_loop_defer(c);
}

/* ── the core for the WebCrypto layer (scr_pki.h) ─────────────────────── */

ScrPkiKey *scr_pki_key_retain(ScrPkiKey *key) { return sp_key_retain(key); }

void scr_pki_key_release(ScrPkiKey *key) { sp_key_release(key); }

bool scr_pki_key_is_private(const ScrPkiKey *key) { return key->private_key; }

bool scr_pki_key_is_rsa(const ScrPkiKey *key) { return sp_is_rsa(key); }

bool scr_pki_key_is_ed25519(const ScrPkiKey *key) { return sp_is_ed(key); }

const char *scr_pki_key_curve(const ScrPkiKey *key) {
  const SpCurve *curve = sp_curve_of(key);
  return curve ? curve->jwk : NULL;
}

size_t scr_pki_key_bits(const ScrPkiKey *key) { return mbedtls_pk_get_bitlen(&key->pk); }

ScrBytes *scr_pki_key_exponent(const ScrPkiKey *key) {
  mbedtls_mpi e;
  mbedtls_mpi_init(&e);
  mbedtls_rsa_export(mbedtls_pk_rsa(key->pk), NULL, NULL, NULL, NULL, &e);
  size_t n = mbedtls_mpi_size(&e);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)n);
  if (n) mbedtls_mpi_write_binary(&e, out->data, n);
  mbedtls_mpi_free(&e);
  return out;
}

ScrPkiKey *scr_pki_key_parse_der(const uint8_t *der, size_t len, bool private_key) {
  if ((private_key && len == 48 && memcmp(der, sp_ed_pkcs8_prefix, 16) == 0) ||
      (!private_key && len == 44 && memcmp(der, sp_ed_spki_prefix, 12) == 0))
  {
    bool failed;
    return sp_ed_from_der(der, len, private_key, &failed);
  }
  SpKey *k = sp_key_alloc(private_key);
  int r = private_key ? mbedtls_pk_parse_key(&k->pk, der, len, NULL, 0, sp_random, NULL)
                      : mbedtls_pk_parse_public_key(&k->pk, der, len);
  if (r != 0 || !sp_key_supported(k)) {
    sp_key_release(k);
    return NULL;
  }
  return k;
}

ScrPkiKey *scr_pki_key_from_jwk(const ScrDyn *jwk, bool private_key) {
  SpKey *k = sp_key_from_jwk(jwk, private_key);
  if (!k) scr_exc_clear();
  return k;
}

ScrPkiKey *scr_pki_key_from_point(const char *curve_name, const uint8_t *point, size_t len) {
  const SpCurve *curve = NULL;
  for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
    if (strcmp(sp_curves[i].jwk, curve_name) == 0) curve = &sp_curves[i];
  if (!curve) return NULL;
  SpKey *k = sp_key_alloc(false);
  bool ok = false;
  if (mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) == 0) {
    mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
    ok = mbedtls_ecp_group_load(&ec->MBEDTLS_PRIVATE(grp), curve->id) == 0 &&
         mbedtls_ecp_point_read_binary(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q), point, len) == 0 &&
         mbedtls_ecp_check_pubkey(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q)) == 0;
  }
  if (!ok) {
    sp_key_release(k);
    return NULL;
  }
  return k;
}

ScrPkiKey *scr_pki_key_public_of(ScrPkiKey *key) { return sp_public_of(key); }

ScrPkiKey *scr_pki_generate_rsa(unsigned bits, uint64_t exponent) {
  SpKey *k = sp_key_alloc(true);
  if (exponent > 2147483647 || mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) != 0 ||
      mbedtls_rsa_gen_key(mbedtls_pk_rsa(k->pk), sp_random, NULL, bits, (int)exponent) != 0) {
    sp_key_release(k);
    return NULL;
  }
  return k;
}

ScrPkiKey *scr_pki_generate_ec(const char *curve_name) {
  const SpCurve *curve = NULL;
  for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
    if (strcmp(sp_curves[i].jwk, curve_name) == 0) curve = &sp_curves[i];
  SpKey *k = sp_key_alloc(true);
  if (!curve || mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) != 0 ||
      mbedtls_ecp_gen_key(curve->id, mbedtls_pk_ec(k->pk), sp_random, NULL) != 0) {
    sp_key_release(k);
    return NULL;
  }
  return k;
}

ScrPkiKey *scr_pki_generate_ed25519(void) {
  const ScrPkiEd25519 *ed = sp_ed();
  if (!ed) return NULL;
  SpKey *k = sp_key_alloc(true);
  k->ed25519 = true;
  sp_random(NULL, k->ed_seed, 32);
  ed->public_key(k->ed_pub, k->ed_seed);
  return k;
}

ScrPkiKey *scr_pki_key_from_ed25519_raw(const uint8_t *raw, size_t len) {
  if (len != 32) return NULL;
  SpKey *k = sp_key_alloc(false);
  k->ed25519 = true;
  memcpy(k->ed_pub, raw, 32);
  return k;
}

ScrBytes *scr_pki_export_ed25519_raw(ScrPkiKey *key) {
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, 32);
  memcpy(out->data, key->ed_pub, 32);
  return out;
}

ScrBytes *scr_pki_export_der(ScrPkiKey *key) {
  unsigned char *der = malloc(SP_DER_MAX);
  if (!der) scr_trap("scriptc: out of memory\n");
  int n = key->private_key ? sp_write_pkcs8_der(key, der, SP_DER_MAX) : sp_write_spki_der(key, der, SP_DER_MAX);
  ScrBytes *out = NULL;
  if (n > 0) {
    out = scr_bytes_new(SCR_BYTES_U8, (double)n);
    memcpy(out->data, der + SP_DER_MAX - n, (size_t)n);
  }
  mbedtls_platform_zeroize(der, SP_DER_MAX);
  free(der);
  return out;
}

ScrBytes *scr_pki_export_point(ScrPkiKey *key) {
  const mbedtls_ecp_keypair *ec = mbedtls_pk_ec(key->pk);
  unsigned char point[160];
  size_t n;
  if (mbedtls_ecp_point_write_binary(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q),
                                     MBEDTLS_ECP_PF_UNCOMPRESSED, &n, point, sizeof point) != 0)
    return NULL;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)n);
  memcpy(out->data, point, n);
  return out;
}

ScrDyn *scr_pki_export_jwk(ScrPkiKey *key) { return sp_export_jwk(key); }

static bool sp_webcrypto_md(const char *hash, mbedtls_md_type_t *md) {
  if (strcmp(hash, "SHA-1") == 0) *md = MBEDTLS_MD_SHA1;
  else if (strcmp(hash, "SHA-256") == 0) *md = MBEDTLS_MD_SHA256;
  else if (strcmp(hash, "SHA-384") == 0) *md = MBEDTLS_MD_SHA384;
  else if (strcmp(hash, "SHA-512") == 0) *md = MBEDTLS_MD_SHA512;
  else return false;
  return true;
}

ScrBytes *scr_pki_sign(ScrPkiKey *key, const char *hash, bool pss, int salt, const uint8_t *data,
                       size_t len) {
  if (sp_is_ed(key)) {
    const ScrPkiEd25519 *ed = sp_ed();
    if (!ed) return NULL;
    ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, 64);
    ed->sign(out->data, key->ed_seed, key->ed_pub, data, len);
    return out;
  }
  mbedtls_md_type_t md;
  if (!sp_webcrypto_md(hash, &md)) return NULL;
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
  unsigned char digest[MBEDTLS_MD_MAX_SIZE];
  mbedtls_md(info, data, len, digest);
  SpSigKey k = {.key = key, .padding = pss ? 6 : 1, .salt = salt, .p1363 = true};
  ScrDyn *sig = sp_sign_hash(&k, md, digest, mbedtls_md_get_size(info));
  if (!sig) {
    scr_exc_clear();
    return NULL;
  }
  ScrBytes *out = scr_bytes_buffer_source(sig);
  scr_dyn_release(sig);
  return out;
}

bool scr_pki_verify(ScrPkiKey *key, const char *hash, bool pss, int salt, const uint8_t *data,
                    size_t len, const uint8_t *signature, size_t signature_len) {
  if (sp_is_ed(key)) {
    const ScrPkiEd25519 *ed = sp_ed();
    return ed && sp_ed_verify(ed, key->ed_pub, data, len, signature, signature_len);
  }
  mbedtls_md_type_t md;
  if (!sp_webcrypto_md(hash, &md)) return false;
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
  unsigned char digest[MBEDTLS_MD_MAX_SIZE];
  mbedtls_md(info, data, len, digest);
  SpSigKey k = {.key = key, .padding = pss ? 6 : 1, .salt = salt, .p1363 = true};
  return sp_verify_hash(&k, md, digest, mbedtls_md_get_size(info), signature, signature_len);
}

/* ── X509Certificate members over keys ───────────────────────────────── */

/* The certificate's public key, +1; NULL with the error pending. */
static SpKey *sp_x509_key(ScrBytes *der) {
  ScrBytes *view = der;
  SCR_BYTES_SNAPSHOT(view);
  const unsigned char *spki;
  size_t spki_len;
  if (!sp_cert_spki(view->data, (size_t)scr_bytes_byte_len(view), &spki, &spki_len)) {
    sp_unsupported_input();
    return NULL;
  }
  return sp_parse(spki, spki_len, false);
}

/* x509.publicKey: the certificate's public key as a new KeyObject. */
ScrDyn *scr_crypto_x509_public_key(ScrBytes *der) {
  SpKey *k = sp_x509_key(der);
  return k ? sp_key_box(k) : NULL;
}

/* The pkey argument of verify (a public key) and checkPrivateKey (a
 * private key), borrowed; NULL with Node's TypeError pending. */
static SpKey *sp_x509_pkey(const ScrDyn *value, bool private_key) {
  SpKey *k = sp_key_of(value);
  size_t len;
  if (!k && !scr_key_object_bytes(value, &len)) {
    scr_dyn_arg_type_fail("pkey", "an instance of KeyObject", value);
    return NULL;
  }
  if (!k || k->private_key != private_key) {
    const char *cls = !k ? "SecretKeyObject" : k->private_key ? "PrivateKeyObject" : "PublicKeyObject";
    scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", "The argument 'pkey' is invalid. Received %s [KeyObject] {}",
                      cls);
    return NULL;
  }
  return k;
}

/* The digest of a signature algorithm OID's last arc (RSA and ECDSA). */
static mbedtls_md_type_t sp_x509_rsa_md(unsigned char arc) {
  switch (arc) {
    case 5: return MBEDTLS_MD_SHA1;
    case 11: return MBEDTLS_MD_SHA256;
    case 12: return MBEDTLS_MD_SHA384;
    case 13: return MBEDTLS_MD_SHA512;
    case 14: return MBEDTLS_MD_SHA224;
    default: return MBEDTLS_MD_NONE;
  }
}

/* A hash AlgorithmIdentifier inside RSASSA-PSS-params. */
static mbedtls_md_type_t sp_x509_hash_alg(unsigned char *p, const unsigned char *end) {
  size_t n;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
    return MBEDTLS_MD_NONE;
  mbedtls_asn1_buf oid = {0};
  oid.tag = MBEDTLS_ASN1_OID;
  if (mbedtls_asn1_get_tag(&p, end, &oid.len, MBEDTLS_ASN1_OID) != 0) return MBEDTLS_MD_NONE;
  oid.p = p;
  mbedtls_md_type_t md;
  return mbedtls_oid_get_md_alg(&oid, &md) == 0 ? md : MBEDTLS_MD_NONE;
}

/* x509.verify(publicKey): whether publicKey verifies the certificate's
 * signature. An algorithm the key cannot verify answers false. */
bool scr_crypto_x509_verify(ScrBytes *der, ScrDyn *key) {
  SpKey *k = sp_x509_pkey(key, false);
  if (!k) return false;
  ScrBytes *view = der;
  SCR_BYTES_SNAPSHOT(view);
  unsigned char *p = view->data;
  const unsigned char *end = p + (size_t)scr_bytes_byte_len(view);
  size_t n;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
    return false;
  end = p + n;
  const unsigned char *tbs = p;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
    return false;
  p += n;
  size_t tbs_len = (size_t)(p - tbs);
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
    return false;
  const unsigned char *alg_end = p + n;
  size_t oid_len;
  if (mbedtls_asn1_get_tag(&p, alg_end, &oid_len, MBEDTLS_ASN1_OID) != 0) return false;
  const unsigned char *oid = p;
  unsigned char *params = p + oid_len;
  p = (unsigned char *)alg_end;
  size_t sig_len;
  if (mbedtls_asn1_get_tag(&p, end, &sig_len, MBEDTLS_ASN1_BIT_STRING) != 0 || sig_len < 1 || *p != 0)
    return false;
  const unsigned char *sig = p + 1;
  sig_len -= 1;
  static const unsigned char rsa_prefix[] = {0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01};
  static const unsigned char ecdsa_prefix[] = {0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04};
  static const unsigned char ed25519_oid[] = {0x2B, 0x65, 0x70};
  if (oid_len == sizeof ed25519_oid && memcmp(oid, ed25519_oid, oid_len) == 0) {
    if (!sp_is_ed(k)) return false;
    const ScrPkiEd25519 *ed = sp_ed();
    return ed != NULL && sp_ed_verify(ed, k->ed_pub, tbs, tbs_len, sig, sig_len);
  }
  if (sp_is_ed(k)) return false;
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  if (oid_len == sizeof rsa_prefix + 1 && memcmp(oid, rsa_prefix, sizeof rsa_prefix) == 0) {
    if (!sp_is_rsa(k)) return false;
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(k->pk);
    if (oid[sizeof rsa_prefix] == 10) { /* RSASSA-PSS with its parameters */
      mbedtls_md_type_t md = MBEDTLS_MD_SHA1, mgf = MBEDTLS_MD_SHA1;
      int salt = 20;
      unsigned char *q = params;
      size_t plen;
      if (mbedtls_asn1_get_tag(&q, alg_end, &plen, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) == 0) {
        const unsigned char *pend = q + plen;
        while (q < pend) {
          unsigned char tag = *q;
          size_t len;
          if (mbedtls_asn1_get_tag(&q, pend, &len, tag) != 0) return false;
          unsigned char *field = q;
          q += len;
          if (tag == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0)) {
            md = sp_x509_hash_alg(field, q);
          } else if (tag == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1)) {
            /* MGF1 with its hash: SEQUENCE { id-mgf1, AlgorithmIdentifier } */
            size_t mlen, ilen;
            unsigned char *m = field;
            if (mbedtls_asn1_get_tag(&m, q, &mlen, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0 ||
                mbedtls_asn1_get_tag(&m, q, &ilen, MBEDTLS_ASN1_OID) != 0)
              return false;
            mgf = sp_x509_hash_alg(m + ilen, q);
          } else if (tag == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 2)) {
            if (mbedtls_asn1_get_int(&field, q, &salt) != 0) return false;
          }
        }
      }
      if (md == MBEDTLS_MD_NONE || mgf == MBEDTLS_MD_NONE || sig_len != mbedtls_rsa_get_len(rsa))
        return false;
      const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
      mbedtls_md(info, tbs, tbs_len, hash);
      return mbedtls_rsa_rsassa_pss_verify_ext(rsa, md, mbedtls_md_get_size(info), hash, mgf, salt,
                                               sig) == 0;
    }
    mbedtls_md_type_t md = sp_x509_rsa_md(oid[sizeof rsa_prefix]);
    if (md == MBEDTLS_MD_NONE) return false;
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
    mbedtls_md(info, tbs, tbs_len, hash);
    return mbedtls_pk_verify(&k->pk, md, hash, mbedtls_md_get_size(info), sig, sig_len) == 0;
  }
  if (oid_len >= sizeof ecdsa_prefix + 1 && memcmp(oid, ecdsa_prefix, sizeof ecdsa_prefix) == 0) {
    if (!sp_is_ec(k)) return false;
    mbedtls_md_type_t md = MBEDTLS_MD_NONE;
    if (oid_len == 7 && oid[6] == 0x01) md = MBEDTLS_MD_SHA1;
    else if (oid_len == 8 && oid[6] == 0x03) {
      static const mbedtls_md_type_t sha2[] = {MBEDTLS_MD_NONE, MBEDTLS_MD_SHA224, MBEDTLS_MD_SHA256,
                                               MBEDTLS_MD_SHA384, MBEDTLS_MD_SHA512};
      if (oid[7] >= 1 && oid[7] <= 4) md = sha2[oid[7]];
    }
    if (md == MBEDTLS_MD_NONE) return false;
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
    mbedtls_md(info, tbs, tbs_len, hash);
    return mbedtls_pk_verify(&k->pk, md, hash, mbedtls_md_get_size(info), sig, sig_len) == 0;
  }
  return false;
}

/* x509.checkPrivateKey(privateKey): whether privateKey is the private half
 * of the certificate's public key. */
bool scr_crypto_x509_check_private_key(ScrBytes *der, ScrDyn *key) {
  SpKey *k = sp_x509_pkey(key, true);
  if (!k) return false;
  SpKey *cert = sp_x509_key(der);
  if (!cert) return false;
  bool same = false;
  if (sp_is_ed(k) || sp_is_ed(cert)) {
    same = sp_is_ed(k) && sp_is_ed(cert) && memcmp(k->ed_pub, cert->ed_pub, 32) == 0;
  } else if (mbedtls_pk_get_type(&k->pk) == mbedtls_pk_get_type(&cert->pk)) {
    SpKey *pub = sp_public_of(k);
    if (pub) {
      unsigned char *a = malloc(SP_DER_MAX), *b = malloc(SP_DER_MAX);
      if (!a || !b) scr_trap("scriptc: out of memory\n");
      int na = sp_write_spki_der(pub, a, SP_DER_MAX);
      int nb = sp_write_spki_der(cert, b, SP_DER_MAX);
      same = na > 0 && na == nb && memcmp(a + SP_DER_MAX - na, b + SP_DER_MAX - nb, (size_t)na) == 0;
      free(a);
      free(b);
      sp_key_release(pub);
    }
  }
  sp_key_release(cert);
  return same;
}
