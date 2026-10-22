/* node:crypto DiffieHellman over the vendored mbedTLS bignum arithmetic:
 * crypto.createDiffieHellman, crypto.getDiffieHellman and
 * crypto.createDiffieHellmanGroup. A DiffieHellman or DiffieHellmanGroup
 * is a native dyn handle. Construction follows Node 24's
 * lib/internal/crypto/diffiehellman.js argument handling and
 * src/crypto/crypto_dh.cc; key generation, verifyError, the public key
 * range check and computeSecret follow the OpenSSL 3 paths of
 * deps/ncrypto and OpenSSL 3.5's DH provider:
 *   - a group draws modp5 through modp18 private keys of a fixed width
 *     (200 to 400 bits) and modp1 and modp2 keys in [2, p - 2], and its
 *     verifyError is 0;
 *   - createDiffieHellman parameters that equal an OpenSSL named group
 *     draw keys below min(2^N, q) for the group's key length N; other
 *     parameters draw keys of bits(p) - 2 bits, and key generation and
 *     computeSecret need a 512- to 10000-bit prime;
 *   - createDiffieHellman(primeLength, generator) generates a safe prime
 *     p ≡ 23 (mod 24) for the generator 2, p ≡ 59 (mod 60) for 5 and
 *     p ≡ 11 (mod 12) otherwise, as OpenSSL's dh_builtin_genparams does.
 * Primes longer than mbedTLS's 8192-bit limit throw a coded SC2020
 * error, as do keys and generators past mbedTLS's 80000-byte limit (leading
 * zero bytes aside). All arguments are borrowed. */
#include "scr_runtime.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/bignum.h"
#include "mbedtls/platform_util.h"

#include "scr_crypto_args.h"
#include "scr_dh_groups.h"

/* The value the SC2020 error for an unlowered encoding names. */
#define SD_SUBJECT "A DiffieHellman encoding"

/* DH_MIN_MODULUS_BITS and OPENSSL_DH_MAX_MODULUS_BITS. */
#define SD_MIN_MODULUS_BITS 512
#define SD_MAX_MODULUS_BITS 10000

/* The longest value an mbedtls_mpi holds, in bytes. */
#define SD_MAX_VALUE_BYTES (MBEDTLS_MPI_MAX_LIMBS * sizeof(mbedtls_mpi_uint))

/* DH_check result bits, as verifyError reports them. */
enum {
  SD_P_NOT_PRIME = 0x01,
  SD_P_NOT_SAFE_PRIME = 0x02,
  SD_NOT_SUITABLE_GENERATOR = 0x08,
  SD_MODULUS_TOO_SMALL = 0x80,
};

/* A crypto.getDiffieHellman group. */
typedef struct {
  const char *name;
  const unsigned char *p;
  size_t p_len;
  int private_bits; /* ncrypto's GetDhGroupPrivateBits; 0 draws keys in [2, p - 2] */
} ScDhGroup;

static const ScDhGroup sd_groups[] = {
  {"modp1", scr_dh_modp1_p, sizeof scr_dh_modp1_p, 0},
  {"modp2", scr_dh_modp2_p, sizeof scr_dh_modp2_p, 0},
  {"modp5", scr_dh_modp5_p, sizeof scr_dh_modp5_p, 200},
  {"modp14", scr_dh_modp14_p, sizeof scr_dh_modp14_p, 225},
  {"modp15", scr_dh_modp15_p, sizeof scr_dh_modp15_p, 275},
  {"modp16", scr_dh_modp16_p, sizeof scr_dh_modp16_p, 325},
  {"modp17", scr_dh_modp17_p, sizeof scr_dh_modp17_p, 375},
  {"modp18", scr_dh_modp18_p, sizeof scr_dh_modp18_p, 400},
};

/* An OpenSSL DH named group, which the DH provider recognizes in explicit
 * p and g. A NULL q is (p - 1) / 2. */
typedef struct {
  const unsigned char *p;
  size_t p_len;
  const unsigned char *g;
  size_t g_len;
  const unsigned char *q;
  size_t q_len;
  int keylength;
} ScDhNamed;

static const unsigned char sd_two[] = {2};

#define SD_SAFE(p, keylength) {p, sizeof p, sd_two, 1, NULL, 0, keylength}
#define SD_RFC5114(name, keylength)                                                                        \
  {scr_dh_##name##_p, sizeof scr_dh_##name##_p, scr_dh_##name##_g, sizeof scr_dh_##name##_g,             \
   scr_dh_##name##_q, sizeof scr_dh_##name##_q, keylength}

static const ScDhNamed sd_named[] = {
  SD_SAFE(scr_dh_ffdhe2048_p, 225), SD_SAFE(scr_dh_ffdhe3072_p, 275), SD_SAFE(scr_dh_ffdhe4096_p, 325),
  SD_SAFE(scr_dh_ffdhe6144_p, 375), SD_SAFE(scr_dh_ffdhe8192_p, 400), SD_SAFE(scr_dh_modp5_p, 200),
  SD_SAFE(scr_dh_modp14_p, 225),    SD_SAFE(scr_dh_modp15_p, 275),    SD_SAFE(scr_dh_modp16_p, 325),
  SD_SAFE(scr_dh_modp17_p, 375),    SD_SAFE(scr_dh_modp18_p, 400),    SD_RFC5114(dh_1024_160, 160),
  SD_RFC5114(dh_2048_224, 224),     SD_RFC5114(dh_2048_256, 224),
};

typedef struct ScDh {
  size_t rc;
  const ScDhGroup *group; /* crypto.getDiffieHellman's group, or NULL */
  const ScDhNamed *named; /* the named group createDiffieHellman's parameters equal, or NULL */
  mbedtls_mpi p, g;
  mbedtls_mpi pub;  /* when has_pub */
  mbedtls_mpi priv; /* when has_priv */
  bool has_pub;
  bool has_priv;
  int verify_error; /* -1 until computed */
} ScDh;

static ScrDynHandleOps sd_ops;
static ScrDynHandleOps sd_group_ops;

static void *sd_retain(void *h) {
  ((ScDh *)h)->rc++;
  return h;
}

static void sd_release(void *h) {
  ScDh *d = h;
  if (--d->rc) return;
  mbedtls_mpi_free(&d->p);
  mbedtls_mpi_free(&d->g);
  mbedtls_mpi_free(&d->pub);
  mbedtls_mpi_free(&d->priv);
  mbedtls_platform_zeroize(d, sizeof *d);
  free(d);
}

static int sd_random(void *state, unsigned char *out, size_t len) {
  (void)state;
  arc4random_buf(out, len);
  return 0;
}

/* ── errors ───────────────────────────────────────────────────────────── */

static void sd_throw(int kind, const char *code, const char *message) {
  scr_throw_error_msg_code(kind, message, strlen(message), code);
}

static void sd_operation_failed(const char *message) {
  sd_throw(SCR_ERR_ERROR, "ERR_CRYPTO_OPERATION_FAILED", message);
}

/* An OpenSSL DH error as ThrowCryptoError reports it: the formatted
 * message plus own library, reason and code properties, in Node's key
 * order. */
static void sd_throw_openssl(const char *packed, const char *reason, const char *code) {
  char message[96];
  snprintf(message, sizeof message, "error:%s:Diffie-Hellman routines::%s", packed, reason);
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  ScrStr *library = scr_str_new("Diffie-Hellman routines", 23);
  scr_error_set_prop(e, "library", 7, scr_dyn_new_str(library));
  scr_str_release(library);
  ScrStr *reason_text = scr_str_new(reason, strlen(reason));
  scr_error_set_prop(e, "reason", 6, scr_dyn_new_str(reason_text));
  scr_str_release(reason_text);
  scr_error_set_code(e, code);
  ScrStr *code_text = scr_str_new(code, strlen(code));
  scr_error_set_prop(e, "code", 4, scr_dyn_new_str(code_text));
  scr_str_release(code_text);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

static void sd_bad_generator(void) {
  sd_throw_openssl("02800065", "bad generator", "ERR_OSSL_DH_BAD_GENERATOR");
}

static void sd_too_long(void) {
  static const char message[] = "DiffieHellman primes longer than 8192 bits have no native implementation";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
}

/* A key or generator past SD_MAX_VALUE_BYTES, which BN_bin2bn reads. */
static void sd_value_too_long(void) {
  char message[96];
  int n = snprintf(message, sizeof message, "DiffieHellman values longer than %zu bytes have no native implementation",
                   (size_t)SD_MAX_VALUE_BYTES);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, n < 0 ? 0 : (size_t)n, "SC2020");
}

/* validateInt32(value, name). */
static bool sd_validate_int32(const char *name, double value) {
  bool integer = isfinite(value) && trunc(value) == value;
  if (integer && value >= INT32_MIN && value <= INT32_MAX) return true;
  char received[48];
  scr_num_received(value, received);
  char text[192];
  int n = integer ? snprintf(text, sizeof text,
                             "The value of \"%s\" is out of range. It must be >= -2147483648 && <= 2147483647. "
                             "Received %s",
                             name, received)
                  : snprintf(text, sizeof text,
                             "The value of \"%s\" is out of range. It must be an integer. Received %s", name,
                             received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, text, n < 0 ? 0 : (size_t)n, "ERR_OUT_OF_RANGE");
  return false;
}

/* ── arithmetic ───────────────────────────────────────────────────────── */

/* The exponent digit width that keeps every mbedtls_mpi_exp_mod exponent
 * within its 8192-bit limit. */
#define SD_DIGIT_BITS (MBEDTLS_MPI_MAX_BITS - 1)

/* base^e mod p, as BN_mod_exp_mont_consttime computes it: false for an
 * even modulus or one below 3. Exponents past 8192 bits are split into
 * SD_DIGIT_BITS-bit digits. */
static bool sd_exp(mbedtls_mpi *out, const mbedtls_mpi *base, const mbedtls_mpi *e, const mbedtls_mpi *p) {
  if (mbedtls_mpi_cmp_int(p, 1) <= 0 || mbedtls_mpi_get_bit(p, 0) == 0) return false;
  size_t ebits = mbedtls_mpi_bitlen(e);
  if (ebits <= MBEDTLS_MPI_MAX_BITS) return mbedtls_mpi_exp_mod(out, base, e, p, NULL) == 0;
  /* base^e = Π (base^(2^(k·w)))^digit_k for the w-bit digits of e. */
  mbedtls_mpi acc, power, digit, term, step;
  mbedtls_mpi_init(&acc);
  mbedtls_mpi_init(&power);
  mbedtls_mpi_init(&digit);
  mbedtls_mpi_init(&term);
  mbedtls_mpi_init(&step);
  int ret = 0;
  MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&acc, 1));
  MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&power, base));
  MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&step, 1));
  MBEDTLS_MPI_CHK(mbedtls_mpi_shift_l(&step, SD_DIGIT_BITS));
  for (size_t offset = 0; offset < ebits; offset += SD_DIGIT_BITS) {
    /* Bit by bit, so each digit costs its own width, not the exponent's. */
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&digit, 0));
    for (size_t bit = 0; bit < SD_DIGIT_BITS && offset + bit < ebits; bit++)
      if (mbedtls_mpi_get_bit(e, offset + bit)) MBEDTLS_MPI_CHK(mbedtls_mpi_set_bit(&digit, bit, 1));
    MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&term, &power, &digit, p, NULL));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&acc, &acc, &term));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&acc, &acc, p));
    if (offset + SD_DIGIT_BITS < ebits) MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&power, &power, &step, p, NULL));
  }
  MBEDTLS_MPI_CHK(mbedtls_mpi_copy(out, &acc));
cleanup:
  mbedtls_mpi_free(&acc);
  mbedtls_mpi_free(&power);
  mbedtls_mpi_free(&digit);
  mbedtls_mpi_free(&term);
  mbedtls_mpi_free(&step);
  return ret == 0;
}

/* Drops a big-endian value's leading zero bytes, which BN_bin2bn ignores
 * but mbedtls_mpi_read_binary counts against SD_MAX_VALUE_BYTES. */
static void sd_strip(const unsigned char **data, size_t *len) {
  while (*len > 0 && **data == 0) {
    (*data)++;
    (*len)--;
  }
}

/* BN_bin2bn: false when the value, without its leading zeros, is longer
 * than SD_MAX_VALUE_BYTES. */
static bool sd_read(mbedtls_mpi *x, const ScrBytes *bytes) {
  const unsigned char *data = bytes->data;
  size_t len = bytes->len;
  sd_strip(&data, &len);
  if (len > SD_MAX_VALUE_BYTES) return false;
  if (mbedtls_mpi_read_binary(x, data, len) != 0) scr_trap("scriptc: out of memory\n");
  return true;
}

/* BN_cmp over two big-endian values, for ones sd_read cannot hold. */
static int sd_cmp_bytes(const ScrBytes *a, const ScrBytes *b) {
  const unsigned char *a_data = a->data, *b_data = b->data;
  size_t a_len = a->len, b_len = b->len;
  sd_strip(&a_data, &a_len);
  sd_strip(&b_data, &b_len);
  if (a_len != b_len) return a_len < b_len ? -1 : 1;
  return a_len ? memcmp(a_data, b_data, a_len) : 0;
}

/* A uniformly random number of exactly `bits` bits (the top bit set), and
 * odd when `odd`, as BN_priv_rand writes it. */
static bool sd_random_bits(mbedtls_mpi *x, size_t bits, bool odd) {
  size_t len = (bits + 7) / 8;
  unsigned char *buf = malloc(len);
  if (!buf) scr_trap("scriptc: out of memory\n");
  arc4random_buf(buf, len);
  unsigned extra = (unsigned)(len * 8 - bits);
  buf[0] &= (unsigned char)(0xff >> extra);
  buf[0] |= (unsigned char)(0x80 >> extra);
  if (odd) buf[len - 1] |= 1;
  bool ok = mbedtls_mpi_read_binary(x, buf, len) == 0;
  mbedtls_platform_zeroize(buf, len);
  free(buf);
  return ok;
}

/* ── primes ───────────────────────────────────────────────────────────── */

/* The odd primes below 17864 (OpenSSL's first 2048 primes but 2), which
 * trial division divides by. Consecutive primes are grouped into products
 * below the half-limb bound mbedtls_mpi_mod_int divides correctly by, so
 * one call reduces by several. */
#define SD_SMALL_PRIMES 2047
#define SD_SMALL_LIMIT 17864
#define SD_PRODUCT_LIMIT ((uint64_t)1 << (sizeof(mbedtls_mpi_uint) * 4))

typedef struct {
  uint16_t primes[SD_SMALL_PRIMES];
  uint64_t products[SD_SMALL_PRIMES];
  uint16_t starts[SD_SMALL_PRIMES + 1]; /* products[g] covers primes[starts[g]] to primes[starts[g + 1] - 1] */
  size_t groups;
  uint32_t mods[SD_SMALL_PRIMES];
} ScDhSmallPrimes;

static ScDhSmallPrimes *sd_small_primes(void) {
  ScDhSmallPrimes *t = calloc(1, sizeof *t);
  unsigned char *composite = calloc(SD_SMALL_LIMIT, 1);
  if (!t || !composite) scr_trap("scriptc: out of memory\n");
  size_t count = 0;
  for (uint32_t n = 3; n < SD_SMALL_LIMIT && count < SD_SMALL_PRIMES; n += 2) {
    if (composite[n]) continue;
    t->primes[count++] = (uint16_t)n;
    for (uint32_t m = n * n; m < SD_SMALL_LIMIT; m += 2 * n) composite[m] = 1;
  }
  free(composite);
  uint64_t product = 1;
  for (size_t i = 0; i < SD_SMALL_PRIMES; i++) {
    if (product > SD_PRODUCT_LIMIT / t->primes[i]) {
      t->products[t->groups++] = product;
      t->starts[t->groups] = (uint16_t)i;
      product = 1;
    }
    product *= t->primes[i];
  }
  t->products[t->groups++] = product;
  t->starts[t->groups] = SD_SMALL_PRIMES;
  return t;
}

/* x mod each small prime, into t->mods. */
static bool sd_small_residues(ScDhSmallPrimes *t, const mbedtls_mpi *x) {
  for (size_t g = 0; g < t->groups; g++) {
    mbedtls_mpi_uint r;
    if (mbedtls_mpi_mod_int(&r, x, (mbedtls_mpi_sint)t->products[g]) != 0) return false;
    for (size_t i = t->starts[g]; i < t->starts[g + 1]; i++) t->mods[i] = (uint32_t)(r % t->primes[i]);
  }
  return true;
}

#if defined(__SIZEOF_INT128__)
#define SD_MONT 1
typedef unsigned __int128 sd_u128;

/* Montgomery arithmetic modulo an odd n of k 64-bit limbs, little-endian,
 * with R = 2^(64k), for the Miller-Rabin rounds. It runs in variable time
 * and reads only public values. */
typedef struct {
  size_t k;
  uint64_t mm;     /* -n^-1 mod 2^64 */
  uint64_t *n;     /* k limbs */
  uint64_t *rr;    /* R^2 mod n, k limbs */
  uint64_t *acc;   /* k limbs */
  uint64_t *table; /* 16·k limbs: base^i·R mod n */
  uint64_t *t;     /* 2k + 1 limbs of products */
} ScDhMont;

static void sd_limbs_read(uint64_t *out, size_t k, const mbedtls_mpi *x, unsigned char *buf) {
  if (mbedtls_mpi_write_binary_le(x, buf, 8 * k) != 0) scr_trap("scriptc: internal error: limb overflow\n");
  for (size_t i = 0; i < k; i++) {
    uint64_t w = 0;
    for (size_t b = 8; b-- > 0;) w = (w << 8) | buf[8 * i + b];
    out[i] = w;
  }
}

static bool sd_limbs_write(mbedtls_mpi *x, const uint64_t *in, size_t k, unsigned char *buf) {
  for (size_t i = 0; i < k; i++)
    for (size_t b = 0; b < 8; b++) buf[8 * i + b] = (unsigned char)(in[i] >> (8 * b));
  return mbedtls_mpi_read_binary_le(x, buf, 8 * k) == 0;
}

static bool sd_mont_init(ScDhMont *m, const mbedtls_mpi *n) {
  size_t k = (mbedtls_mpi_bitlen(n) + 63) / 64;
  m->k = k;
  m->n = calloc(21 * k + 1, sizeof(uint64_t));
  if (!m->n) scr_trap("scriptc: out of memory\n");
  m->rr = m->n + k;
  m->acc = m->rr + k;
  m->table = m->acc + k;
  m->t = m->table + 16 * k;
  unsigned char *buf = malloc(8 * k);
  if (!buf) scr_trap("scriptc: out of memory\n");
  sd_limbs_read(m->n, k, n, buf);
  /* Newton's iteration doubles the correct low bits of n^-1 from 3. */
  uint64_t inverse = m->n[0];
  for (int i = 0; i < 6; i++) inverse *= 2 - m->n[0] * inverse;
  m->mm = (uint64_t)0 - inverse;
  mbedtls_mpi rr;
  mbedtls_mpi_init(&rr);
  bool ok = mbedtls_mpi_lset(&rr, 1) == 0 && mbedtls_mpi_shift_l(&rr, 128 * k) == 0 &&
            mbedtls_mpi_mod_mpi(&rr, &rr, n) == 0;
  if (ok) sd_limbs_read(m->rr, k, &rr, buf);
  mbedtls_mpi_free(&rr);
  free(buf);
  return ok;
}

static void sd_mont_free(ScDhMont *m) {
  free(m->n);
}

/* r = v mod n for v < 2n, given as k limbs and a top limb. */
static void sd_mont_final(const ScDhMont *m, uint64_t *r, const uint64_t *v, uint64_t top) {
  size_t k = m->k;
  bool ge = top != 0;
  if (!ge) {
    ge = true;
    for (size_t j = k; j-- > 0;)
      if (v[j] != m->n[j]) {
        ge = v[j] > m->n[j];
        break;
      }
  }
  if (!ge) {
    if (r != v) memmove(r, v, k * sizeof *r);
    return;
  }
  uint64_t borrow = 0;
  for (size_t j = 0; j < k; j++) {
    sd_u128 d = (sd_u128)v[j] - m->n[j] - borrow;
    r[j] = (uint64_t)d;
    borrow = (uint64_t)(d >> 64) & 1;
  }
}

/* r = t·R^-1 mod n for the 2k-limb product in t. */
static void sd_mont_redc(ScDhMont *m, uint64_t *r) {
  size_t k = m->k;
  uint64_t *t = m->t;
  t[2 * k] = 0;
  for (size_t i = 0; i < k; i++) {
    uint64_t q = t[i] * m->mm;
    uint64_t carry = 0;
    for (size_t j = 0; j < k; j++) {
      sd_u128 v = (sd_u128)q * m->n[j] + t[i + j] + carry;
      t[i + j] = (uint64_t)v;
      carry = (uint64_t)(v >> 64);
    }
    for (size_t j = i + k; carry != 0 && j <= 2 * k; j++) {
      sd_u128 v = (sd_u128)t[j] + carry;
      t[j] = (uint64_t)v;
      carry = (uint64_t)(v >> 64);
    }
  }
  sd_mont_final(m, r, t + k, t[2 * k]);
}

static void sd_mont_mul(ScDhMont *m, uint64_t *r, const uint64_t *a, const uint64_t *b) {
  size_t k = m->k;
  uint64_t *t = m->t;
  memset(t, 0, 2 * k * sizeof *t);
  for (size_t i = 0; i < k; i++) {
    uint64_t carry = 0;
    for (size_t j = 0; j < k; j++) {
      sd_u128 v = (sd_u128)a[i] * b[j] + t[i + j] + carry;
      t[i + j] = (uint64_t)v;
      carry = (uint64_t)(v >> 64);
    }
    t[i + k] = carry;
  }
  sd_mont_redc(m, r);
}

/* r = a^2·R^-1 mod n: the cross products once, doubled, plus the squares. */
static void sd_mont_sqr(ScDhMont *m, uint64_t *r, const uint64_t *a) {
  size_t k = m->k;
  uint64_t *t = m->t;
  memset(t, 0, 2 * k * sizeof *t);
  for (size_t i = 0; i < k; i++) {
    uint64_t carry = 0;
    for (size_t j = i + 1; j < k; j++) {
      sd_u128 v = (sd_u128)a[i] * a[j] + t[i + j] + carry;
      t[i + j] = (uint64_t)v;
      carry = (uint64_t)(v >> 64);
    }
    t[i + k] = carry;
  }
  uint64_t shifted = 0;
  for (size_t i = 0; i < 2 * k; i++) {
    uint64_t v = t[i];
    t[i] = (v << 1) | shifted;
    shifted = v >> 63;
  }
  uint64_t carry = 0;
  for (size_t i = 0; i < k; i++) {
    sd_u128 square = (sd_u128)a[i] * a[i];
    sd_u128 low = (sd_u128)t[2 * i] + (uint64_t)square + carry;
    t[2 * i] = (uint64_t)low;
    sd_u128 high = (sd_u128)t[2 * i + 1] + (uint64_t)(square >> 64) + (uint64_t)(low >> 64);
    t[2 * i + 1] = (uint64_t)high;
    carry = (uint64_t)(high >> 64);
  }
  sd_mont_redc(m, r);
}

/* x = 2x mod n. */
static void sd_mont_double(const ScDhMont *m, uint64_t *x) {
  size_t k = m->k;
  uint64_t top = x[k - 1] >> 63;
  for (size_t j = k; j-- > 1;) x[j] = (x[j] << 1) | (x[j - 1] >> 63);
  x[0] <<= 1;
  sd_mont_final(m, x, x, top);
}

/* out = base^e mod n, or 2^e mod n for a NULL base. A base of 2 doubles
 * instead of multiplying; others use a 4-bit fixed window. */
static bool sd_mont_pow(ScDhMont *m, mbedtls_mpi *out, const mbedtls_mpi *base, const mbedtls_mpi *e) {
  size_t k = m->k;
  unsigned char *buf = malloc(8 * k);
  if (!buf) scr_trap("scriptc: out of memory\n");
  /* acc = R mod n, the Montgomery form of 1. */
  memset(m->t, 0, 2 * k * sizeof *m->t);
  memcpy(m->t, m->rr, k * sizeof *m->t);
  sd_mont_redc(m, m->acc);
  size_t bits = mbedtls_mpi_bitlen(e);
  if (!base) {
    for (size_t i = bits; i-- > 0;) {
      sd_mont_sqr(m, m->acc, m->acc);
      if (mbedtls_mpi_get_bit(e, i)) sd_mont_double(m, m->acc);
    }
  } else {
    memcpy(m->table, m->acc, k * sizeof *m->table);
    sd_limbs_read(m->table + k, k, base, buf);
    sd_mont_mul(m, m->table + k, m->table + k, m->rr);
    for (size_t i = 2; i < 16; i++) sd_mont_mul(m, m->table + i * k, m->table + (i - 1) * k, m->table + k);
    size_t windows = (bits + 3) / 4;
    for (size_t w = windows; w-- > 0;) {
      if (w + 1 < windows)
        for (int s = 0; s < 4; s++) sd_mont_sqr(m, m->acc, m->acc);
      unsigned digit = 0;
      for (size_t b = 4; b-- > 0;) digit = (digit << 1) | (unsigned)mbedtls_mpi_get_bit(e, 4 * w + b);
      if (digit) sd_mont_mul(m, m->acc, m->acc, m->table + digit * k);
    }
  }
  /* Leave the Montgomery form. */
  memset(m->t, 0, 2 * k * sizeof *m->t);
  memcpy(m->t, m->acc, k * sizeof *m->t);
  sd_mont_redc(m, m->acc);
  bool ok = sd_limbs_write(out, m->acc, k, buf);
  free(buf);
  return ok;
}
#else
#define SD_MONT 0
#endif

/* Miller-Rabin state for an odd n > 3: n - 1 = d·2^s. */
typedef struct {
  mbedtls_mpi n1, d, a, x;
  size_t s;
#if SD_MONT
  ScDhMont mont;
#else
  mbedtls_mpi rr; /* the Montgomery constant mbedtls_mpi_exp_mod caches */
#endif
} ScDhMillerRabin;

static bool sd_mr_init(ScDhMillerRabin *m, const mbedtls_mpi *n) {
  mbedtls_mpi_init(&m->n1);
  mbedtls_mpi_init(&m->d);
  mbedtls_mpi_init(&m->a);
  mbedtls_mpi_init(&m->x);
#if SD_MONT
  if (!sd_mont_init(&m->mont, n)) return false;
#else
  mbedtls_mpi_init(&m->rr);
#endif
  if (mbedtls_mpi_sub_int(&m->n1, n, 1) != 0 || mbedtls_mpi_copy(&m->d, &m->n1) != 0) return false;
  m->s = mbedtls_mpi_lsb(&m->d);
  return mbedtls_mpi_shift_r(&m->d, m->s) == 0;
}

static void sd_mr_free(ScDhMillerRabin *m) {
  mbedtls_mpi_free(&m->n1);
  mbedtls_mpi_free(&m->d);
  mbedtls_mpi_free(&m->a);
  mbedtls_mpi_free(&m->x);
#if SD_MONT
  sd_mont_free(&m->mont);
#else
  mbedtls_mpi_free(&m->rr);
#endif
}

/* x = a^e mod n, or 2^e mod n when base2. */
static bool sd_mr_pow(ScDhMillerRabin *m, const mbedtls_mpi *n, const mbedtls_mpi *e, bool base2) {
#if SD_MONT
  (void)n;
  return sd_mont_pow(&m->mont, &m->x, base2 ? NULL : &m->a, e);
#else
  if (base2 && mbedtls_mpi_lset(&m->a, 2) != 0) return false;
  return mbedtls_mpi_exp_mod(&m->x, &m->a, e, n, &m->rr) == 0;
#endif
}

/* One round with the base 2, or with a uniformly random base in
 * [2, n - 2]: 1 when n is a strong probable prime to the base, 0 when it
 * is composite, -1 when an operation fails. */
static int sd_mr_round(ScDhMillerRabin *m, const mbedtls_mpi *n, bool base2) {
  if (!base2 && mbedtls_mpi_random(&m->a, 2, &m->n1, sd_random, NULL) != 0) return -1;
  if (!sd_mr_pow(m, n, &m->d, base2)) return -1;
  if (mbedtls_mpi_cmp_int(&m->x, 1) == 0 || mbedtls_mpi_cmp_mpi(&m->x, &m->n1) == 0) return 1;
  for (size_t i = 1; i < m->s; i++) {
    if (mbedtls_mpi_mul_mpi(&m->x, &m->x, &m->x) != 0 || mbedtls_mpi_mod_mpi(&m->x, &m->x, n) != 0) return -1;
    if (mbedtls_mpi_cmp_mpi(&m->x, &m->n1) == 0) return 1;
    if (mbedtls_mpi_cmp_int(&m->x, 1) == 0) return 0;
  }
  return 0;
}

/* 2^(n-1) ≡ 1 (mod n) for an odd n > 3. */
static int sd_fermat2(const mbedtls_mpi *n) {
  ScDhMillerRabin m;
  int ret = sd_mr_init(&m, n) && sd_mr_pow(&m, n, &m.n1, true) ? mbedtls_mpi_cmp_int(&m.x, 1) == 0 : -1;
  sd_mr_free(&m);
  return ret;
}

/* OpenSSL's Miller-Rabin round count: 64, or 128 past 2048 bits. */
static int sd_mr_rounds(size_t bits) {
  return bits > 2048 ? 128 : 64;
}

/* BN_check_prime: trial division by the small primes, then Miller-Rabin
 * rounds with random bases. */
static bool sd_is_prime(ScDhSmallPrimes *t, const mbedtls_mpi *x) {
  if (mbedtls_mpi_cmp_int(x, 2) < 0) return false;
  if (mbedtls_mpi_get_bit(x, 0) == 0) return mbedtls_mpi_cmp_int(x, 2) == 0;
  if (!sd_small_residues(t, x)) return false;
  for (size_t i = 0; i < SD_SMALL_PRIMES; i++)
    if (t->mods[i] == 0) return mbedtls_mpi_cmp_int(x, t->primes[i]) == 0;
  /* No prime factor up to sqrt(x). */
  if (mbedtls_mpi_cmp_int(x, (mbedtls_mpi_sint)SD_SMALL_LIMIT * SD_SMALL_LIMIT) < 0) return true;
  ScDhMillerRabin m;
  bool prime = sd_mr_init(&m, x);
  int rounds = sd_mr_rounds(mbedtls_mpi_bitlen(x));
  for (int i = 0; i < rounds && prime; i++) prime = sd_mr_round(&m, x, false) == 1;
  sd_mr_free(&m);
  return prime;
}

/* DH_check for parameters without q, as ncrypto's CheckDhParams reports
 * it. */
static int sd_check_params(const mbedtls_mpi *p, const mbedtls_mpi *g) {
  int codes = 0;
  if (mbedtls_mpi_get_bit(p, 0) == 0) codes |= SD_P_NOT_PRIME;
  if (mbedtls_mpi_cmp_int(g, 1) <= 0) codes |= SD_NOT_SUITABLE_GENERATOR;
  if (mbedtls_mpi_bitlen(p) < SD_MIN_MODULUS_BITS) codes |= SD_MODULUS_TOO_SMALL;
  mbedtls_mpi t;
  mbedtls_mpi_init(&t);
  if (mbedtls_mpi_sub_int(&t, p, 1) != 0) scr_trap("scriptc: out of memory\n");
  if (mbedtls_mpi_cmp_mpi(g, &t) >= 0) codes |= SD_NOT_SUITABLE_GENERATOR;
  /* BN_check_prime(p), then BN_check_prime((p - 1) / 2) for a prime p.
   * For an odd p > 3 whose (p - 1) / 2 is prime, p is prime exactly when
   * 3 does not divide it and 2^(p-1) ≡ 1 (mod p) (Pocklington's
   * criterion), so (p - 1) / 2 is tested first. */
  ScDhSmallPrimes *small = sd_small_primes();
  if (mbedtls_mpi_copy(&t, p) != 0 || mbedtls_mpi_shift_r(&t, 1) != 0) scr_trap("scriptc: out of memory\n");
  bool p_prime, q_prime;
  if (mbedtls_mpi_get_bit(p, 0) == 0 || mbedtls_mpi_cmp_int(p, 3) <= 0) {
    p_prime = sd_is_prime(small, p);
    q_prime = p_prime && sd_is_prime(small, &t);
  } else {
    q_prime = sd_is_prime(small, &t);
    mbedtls_mpi_uint r = 0;
    if (!q_prime) p_prime = sd_is_prime(small, p);
    else p_prime = mbedtls_mpi_mod_int(&r, p, 3) == 0 && r != 0 && sd_fermat2(p) == 1;
  }
  if (!p_prime) codes |= SD_P_NOT_PRIME;
  else if (!q_prime) codes |= SD_P_NOT_SAFE_PRIME;
  free(small);
  mbedtls_mpi_free(&t);
  return codes;
}

/* The named group whose p and g equal these, as ossl_dh_cache_named_group
 * finds it, or NULL. */
static const ScDhNamed *sd_find_named(const mbedtls_mpi *p, const mbedtls_mpi *g) {
  size_t p_len = mbedtls_mpi_size(p);
  const ScDhNamed *found = NULL;
  mbedtls_mpi x;
  mbedtls_mpi_init(&x);
  for (size_t i = 0; i < sizeof sd_named / sizeof sd_named[0] && !found; i++) {
    const ScDhNamed *n = &sd_named[i];
    if (n->p_len != p_len) continue;
    if (mbedtls_mpi_read_binary(&x, n->p, n->p_len) != 0 || mbedtls_mpi_cmp_mpi(&x, p) != 0) continue;
    if (mbedtls_mpi_read_binary(&x, n->g, n->g_len) == 0 && mbedtls_mpi_cmp_mpi(&x, g) == 0) found = n;
  }
  mbedtls_mpi_free(&x);
  return found;
}

/* The safe-prime sieve: the odd primes below a bound that grows with the
 * prime's length and do not divide the step `add`, each with add^-1 and a
 * start's residue modulo it, and the marks of a window of candidates
 * start + k·add. */
#define SD_SIEVE_WINDOW 65536

static uint32_t sd_sieve_bound(size_t bits) {
  /* mbedtls_mpi_mod_int divides correctly by values below 2^(limb bits / 2). */
  if (sizeof(mbedtls_mpi_uint) < 8) return 1u << 16;
  return bits < 1024 ? 1u << 18 : bits < 2048 ? 1u << 22 : 1u << 24;
}

typedef struct {
  uint32_t *primes;
  uint32_t *inverse;
  uint32_t *residue;
  size_t count;
  unsigned char marks[SD_SIEVE_WINDOW];
} ScDhSieve;

/* a^-1 mod m for gcd(a, m) = 1. */
static uint32_t sd_inverse(uint32_t a, uint32_t m) {
  int64_t t = 0, next = 1;
  int64_t r = m, rest = a;
  while (rest != 0) {
    int64_t quotient = r / rest;
    int64_t t_next = t - quotient * next;
    t = next;
    next = t_next;
    int64_t r_next = r - quotient * rest;
    r = rest;
    rest = r_next;
  }
  return (uint32_t)(t < 0 ? t + m : t);
}

static ScDhSieve *sd_sieve_new(size_t bits, unsigned add) {
  uint32_t bound = sd_sieve_bound(bits);
  ScDhSieve *sv = calloc(1, sizeof *sv);
  unsigned char *composite = calloc(bound / 2, 1); /* composite[i] for 2i + 1 */
  if (!sv || !composite) scr_trap("scriptc: out of memory\n");
  size_t count = 0;
  for (uint32_t i = 1; i < bound / 2; i++) {
    if (composite[i]) continue;
    uint32_t n = 2 * i + 1;
    for (uint64_t m = (uint64_t)n * n; m < bound; m += 2 * n) composite[m / 2] = 1;
    if (add % n != 0) count++;
  }
  sv->primes = malloc(count * sizeof(uint32_t));
  sv->inverse = malloc(count * sizeof(uint32_t));
  sv->residue = malloc(count * sizeof(uint32_t));
  if (!sv->primes || !sv->inverse || !sv->residue) scr_trap("scriptc: out of memory\n");
  for (uint32_t i = 1; i < bound / 2; i++) {
    uint32_t n = 2 * i + 1;
    if (composite[i] || add % n == 0) continue;
    sv->inverse[sv->count] = sd_inverse(add % n, n);
    sv->primes[sv->count++] = n;
  }
  free(composite);
  return sv;
}

static void sd_sieve_free(ScDhSieve *sv) {
  free(sv->primes);
  free(sv->inverse);
  free(sv->residue);
  free(sv);
}

/* Marks the candidates start + k·add of the window that a sieve prime
 * divides, or whose (p - 1) / 2 it divides, then moves the residues to
 * the next window. */
static void sd_sieve_window(ScDhSieve *sv, unsigned add) {
  memset(sv->marks, 0, sizeof sv->marks);
  for (size_t i = 0; i < sv->count; i++) {
    uint64_t r = sv->primes[i];
    uint64_t s = sv->residue[i];
    /* start + k·add ≡ t (mod r) for t = 0 and t = 1. */
    for (uint64_t t = 0; t < 2; t++) {
      uint64_t k = (r + t - s) % r * sv->inverse[i] % r;
      for (; k < SD_SIEVE_WINDOW; k += r) sv->marks[k] = 1;
    }
    sv->residue[i] = (uint32_t)((s + (uint64_t)SD_SIEVE_WINDOW * add) % r);
  }
}

/* A random safe prime of exactly `bits` bits with p ≡ rem (mod add),
 * rem ≡ 2 (mod 3), as BN_generate_prime_ex2(p, bits, safe = 1, add, rem)
 * draws one: a random start of `bits` bits moved to p ≡ rem (mod add),
 * then candidates stepping by `add` past values that a sieve prime
 * divides or that make (p - 1) / 2 divisible by one. A candidate is kept
 * when p is a strong probable prime to the base 2 and q = (p - 1) / 2
 * passes OpenSSL's Miller-Rabin round count; a prime q then proves p prime
 * (Pocklington's criterion with 2^(p-1) ≡ 1 and gcd(2^2 - 1, p) = 1).
 * Candidates past `bits` bits take a new start. */
static bool sd_generate_safe_prime(mbedtls_mpi *p, size_t bits, unsigned add, unsigned rem) {
  ScDhSieve *sv = sd_sieve_new(bits, add);
  int rounds = sd_mr_rounds(bits);
  mbedtls_mpi start, q;
  mbedtls_mpi_init(&start);
  mbedtls_mpi_init(&q);
  int ret = 0;
  while (ret == 0) {
    mbedtls_mpi_uint r;
    if (!sd_random_bits(&start, bits, true) || mbedtls_mpi_mod_int(&r, &start, add) != 0 ||
        mbedtls_mpi_sub_int(&start, &start, (mbedtls_mpi_sint)r) != 0 ||
        mbedtls_mpi_add_int(&start, &start, rem) != 0 ||
        (mbedtls_mpi_bitlen(&start) < bits && mbedtls_mpi_add_int(&start, &start, add) != 0)) {
      ret = -1;
      break;
    }
    for (size_t i = 0; i < sv->count && ret == 0; i++) {
      if (mbedtls_mpi_mod_int(&r, &start, sv->primes[i]) != 0) ret = -1;
      sv->residue[i] = (uint32_t)r;
    }
    bool fits = true;
    while (ret == 0 && fits) {
      sd_sieve_window(sv, add);
      for (uint32_t k = 0; k < SD_SIEVE_WINDOW && ret == 0 && fits; k++) {
        if (sv->marks[k]) continue;
        if (mbedtls_mpi_add_int(p, &start, (mbedtls_mpi_sint)k * add) != 0 || mbedtls_mpi_copy(&q, p) != 0 ||
            mbedtls_mpi_shift_r(&q, 1) != 0) {
          ret = -1;
          break;
        }
        fits = mbedtls_mpi_bitlen(p) == bits;
        if (!fits) break;
        ScDhMillerRabin mr;
        ret = sd_mr_init(&mr, p) ? sd_mr_round(&mr, p, true) : -1;
        sd_mr_free(&mr);
        if (ret != 1) continue;
        ret = sd_mr_init(&mr, &q) ? sd_mr_round(&mr, &q, true) : -1;
        for (int i = 1; i < rounds && ret == 1; i++) ret = sd_mr_round(&mr, &q, false);
        sd_mr_free(&mr);
      }
      if (ret == 0 && fits && mbedtls_mpi_add_int(&start, &start, (mbedtls_mpi_sint)SD_SIEVE_WINDOW * add) != 0)
        ret = -1;
    }
  }
  sd_sieve_free(sv);
  mbedtls_mpi_free(&start);
  mbedtls_mpi_free(&q);
  return ret == 1;
}

/* ── construction ─────────────────────────────────────────────────────── */

static ScDh *sd_alloc(void) {
  ScDh *d = calloc(1, sizeof *d);
  if (!d) scr_trap("scriptc: out of memory\n");
  d->rc = 1;
  mbedtls_mpi_init(&d->p);
  mbedtls_mpi_init(&d->g);
  mbedtls_mpi_init(&d->pub);
  mbedtls_mpi_init(&d->priv);
  return d;
}

static ScrDyn *sd_box(ScDh *d) {
  ScrDynHandleTag tag = d->group ? SCR_DYNH_DIFFIE_HELLMAN_GROUP : SCR_DYNH_DIFFIE_HELLMAN;
  scr_dyn_handle_install(tag, d->group ? &sd_group_ops : &sd_ops);
  ScrDyn *result = scr_dyn_new_handle(d, tag); /* retains */
  sd_release(d);
  return result;
}

static bool sd_is_view(const ScrDyn *value) {
  return value->kind == SCR_DYN_BYTES || scr_buffer_storage_is(value);
}

/* Buffer.isEncoding(value). */
static bool sd_is_encoding(const ScrDyn *value) {
  return value->kind == SCR_DYN_STR && value->v.str->len > 0 && ca_normalize_encoding(value->v.str) != NULL;
}

/* new DiffieHellman(primeLength, generator): generated parameters. */
static ScrDyn *sd_generate(double bits, const ScrBytes *generator_bytes, double generator) {
  if (bits < 2) {
    sd_throw_openssl("0280007E", "modulus too small", "ERR_OSSL_DH_MODULUS_TOO_SMALL");
    return NULL;
  }
  if (generator_bytes) {
    sd_throw(SCR_ERR_TYPE, "ERR_INVALID_ARG_TYPE", "Second argument must be an int32");
    return NULL;
  }
  if (generator < 2) {
    sd_bad_generator();
    return NULL;
  }
  if (bits < SD_MIN_MODULUS_BITS || bits > SD_MAX_MODULUS_BITS) {
    sd_throw(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", "Invalid DH parameters");
    return NULL;
  }
  if (bits > MBEDTLS_MPI_MAX_BITS) {
    sd_too_long();
    return NULL;
  }
  unsigned add = 12;
  if (generator == 2) add = 24;
  else if (generator == 5) add = 60;
  ScDh *d = sd_alloc();
  if (!sd_generate_safe_prime(&d->p, (size_t)bits, add, add - 1) || mbedtls_mpi_lset(&d->g, (mbedtls_mpi_sint)generator) != 0) {
    sd_release(d);
    sd_throw(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", "Invalid DH parameters");
    return NULL;
  }
  /* A safe prime of at least 512 bits with a generator below p - 1 has no
   * DH_check findings. */
  d->verify_error = 0;
  return sd_box(d);
}

/* new DiffieHellman(prime, generator) over explicit parameters. */
static ScrDyn *sd_from_prime(const ScrBytes *prime, const ScrBytes *generator_bytes, double generator) {
  ScDh *d = sd_alloc();
  bool p_held = sd_read(&d->p, prime);
  bool g_held = true;
  if (generator_bytes) g_held = sd_read(&d->g, generator_bytes);
  else if (mbedtls_mpi_lset(&d->g, (mbedtls_mpi_sint)generator) != 0) scr_trap("scriptc: out of memory\n");
  if (!p_held || !g_held) {
    /* A prime this long is past MBEDTLS_MPI_MAX_BITS, and a generator
     * this long is at least a prime of SD_MIN_MODULUS_BITS. */
    bool bad = g_held    ? mbedtls_mpi_cmp_int(&d->g, 2) < 0
               : !p_held ? sd_cmp_bytes(generator_bytes, prime) >= 0
                         : mbedtls_mpi_bitlen(&d->p) >= SD_MIN_MODULUS_BITS;
    sd_release(d);
    if (bad) sd_bad_generator();
    else if (!p_held) sd_too_long();
    else sd_value_too_long();
    return NULL;
  }
  if (mbedtls_mpi_cmp_int(&d->g, 2) < 0 ||
      (mbedtls_mpi_bitlen(&d->p) >= SD_MIN_MODULUS_BITS && mbedtls_mpi_cmp_mpi(&d->g, &d->p) >= 0)) {
    sd_release(d);
    sd_bad_generator();
    return NULL;
  }
  if (mbedtls_mpi_bitlen(&d->p) > MBEDTLS_MPI_MAX_BITS) {
    sd_release(d);
    sd_too_long();
    return NULL;
  }
  d->named = sd_find_named(&d->p, &d->g);
  /* A named group's parameters have no DH_check findings. Other
   * parameters are checked when verifyError is first read. */
  d->verify_error = d->named ? 0 : -1;
  return sd_box(d);
}

/* new DiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding). */
static ScrDyn *sd_new(const ScrDyn *size_or_key, const ScrDyn *key_encoding, const ScrDyn *generator,
                      const ScrDyn *generator_encoding) {
  static const char *const types =
    "one of type number or string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView";
  bool size = size_or_key->kind == SCR_DYN_NUM;
  if (!size && size_or_key->kind != SCR_DYN_STR && !sd_is_view(size_or_key)) {
    scr_dyn_arg_type_fail("sizeOrKey", types, size_or_key);
    return NULL;
  }
  if (size && !sd_validate_int32("sizeOrKey", size_or_key->v.num)) return NULL;
  /* A truthy keyEncoding that names no encoding is the generator. */
  const ScrDyn *gen = generator;
  const ScrDyn *gen_encoding = generator_encoding;
  const ScrDyn *encoding = key_encoding;
  if (scr_dyn_truthy(key_encoding) && !sd_is_encoding(key_encoding) &&
      !(key_encoding->kind == SCR_DYN_STR && ca_str_is(key_encoding->v.str, "buffer"))) {
    gen_encoding = generator;
    gen = key_encoding;
    encoding = scr_dyn_undefined();
  }
  ScrBytes *prime = NULL;
  if (size_or_key->kind == SCR_DYN_STR) prime = ca_string_bytes(SD_SUBJECT, size_or_key->v.str, encoding);
  else if (!size) prime = scr_bytes_buffer_source(size_or_key);
  if (!size && !prime) return NULL;
  ScrBytes *gen_bytes = NULL;
  double gen_number = 2;
  ScrDyn *result = NULL;
  if (!scr_dyn_truthy(gen)) {
    gen_number = 2;
  } else if (gen->kind == SCR_DYN_NUM) {
    if (!sd_validate_int32("generator", gen->v.num)) goto done;
    gen_number = gen->v.num;
  } else if (gen->kind == SCR_DYN_STR) {
    if (!(gen_bytes = ca_string_bytes(SD_SUBJECT, gen->v.str, gen_encoding))) goto done;
  } else if (sd_is_view(gen)) {
    gen_bytes = scr_bytes_buffer_source(gen);
  } else {
    scr_dyn_arg_type_fail("generator", types, gen);
    goto done;
  }
  result = size ? sd_generate(size_or_key->v.num + 0, gen_bytes, gen_number)
                : sd_from_prime(prime, gen_bytes, gen_number);
done:
  if (prime) scr_bytes_release(prime);
  if (gen_bytes) scr_bytes_release(gen_bytes);
  return result;
}

ScrDyn *scr_crypto_dh_new(ScrDyn *size_or_key, ScrDyn *key_encoding, ScrDyn *generator, ScrDyn *generator_encoding) {
  ScrDyn *args[4] = {size_or_key, key_encoding, generator, generator_encoding};
  ScrDyn *unboxed[4] = {NULL, NULL, NULL, NULL};
  ScrDyn *result = NULL;
  for (size_t i = 0; i < 4; i++)
    if (!(unboxed[i] = ca_unbox(args[i]))) goto done;
  result = sd_new(unboxed[0], unboxed[1], unboxed[2], unboxed[3]);
done:
  for (size_t i = 0; i < 4; i++) scr_dyn_release(unboxed[i]);
  return result;
}

/* new DiffieHellmanGroup(name): names match case-insensitively. */
ScrDyn *scr_crypto_dh_group_new(ScrDyn *name) {
  ScrDyn *unboxed = ca_unbox(name);
  if (!unboxed) return NULL;
  if (unboxed->kind != SCR_DYN_STR) {
    scr_dyn_release(unboxed);
    sd_throw(SCR_ERR_TYPE, "ERR_INVALID_ARG_TYPE", "Group name must be a string");
    return NULL;
  }
  const ScDhGroup *group = NULL;
  for (size_t i = 0; i < sizeof sd_groups / sizeof sd_groups[0] && !group; i++)
    if (ca_ascii_eq_ci(unboxed->v.str->data, unboxed->v.str->len, sd_groups[i].name)) group = &sd_groups[i];
  scr_dyn_release(unboxed);
  if (!group) {
    sd_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNKNOWN_DH_GROUP", "Unknown DH group");
    return NULL;
  }
  ScDh *d = sd_alloc();
  d->group = group;
  if (mbedtls_mpi_read_binary(&d->p, group->p, group->p_len) != 0 || mbedtls_mpi_lset(&d->g, 2) != 0)
    scr_trap("scriptc: out of memory\n");
  d->verify_error = 0;
  return sd_box(d);
}

/* ── methods ──────────────────────────────────────────────────────────── */

static ScrDyn *sd_arg(ScrDyn *const *args, size_t argc, size_t index) {
  return index < argc ? args[index] : scr_dyn_undefined();
}

/* The minimal big-endian bytes of a value, as BignumPointer::Encode
 * writes them (none for 0), passed through encode(). */
static ScrDyn *sd_encode_value(const mbedtls_mpi *value, const ScrDyn *encoding) {
  size_t len = mbedtls_mpi_size(value);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (mbedtls_mpi_write_binary(value, out->data, len) != 0) scr_trap("scriptc: out of memory\n");
  return ca_encode(SD_SUBJECT, out, encoding);
}

/* A new private key for generateKeys(). */
static bool sd_new_private_key(ScDh *d, mbedtls_mpi *priv) {
  if (d->group) {
    if (d->group->private_bits) return sd_random_bits(priv, (size_t)d->group->private_bits, false);
    /* BN_priv_rand_range(p - 3) + 2. */
    mbedtls_mpi bound;
    mbedtls_mpi_init(&bound);
    bool ok = mbedtls_mpi_sub_int(&bound, &d->p, 1) == 0 && mbedtls_mpi_random(priv, 2, &bound, sd_random, NULL) == 0;
    mbedtls_mpi_free(&bound);
    return ok;
  }
  size_t bits = mbedtls_mpi_bitlen(&d->p);
  if (bits < SD_MIN_MODULUS_BITS || bits > SD_MAX_MODULUS_BITS) return false;
  if (!d->named) return sd_random_bits(priv, bits - 2, false);
  /* ossl_ffc_generate_private_key: 1 <= priv < min(2^N, q). */
  mbedtls_mpi bound, q;
  mbedtls_mpi_init(&bound);
  mbedtls_mpi_init(&q);
  bool ok = mbedtls_mpi_lset(&bound, 1) == 0 && mbedtls_mpi_shift_l(&bound, (size_t)d->named->keylength) == 0;
  if (ok && d->named->q) ok = mbedtls_mpi_read_binary(&q, d->named->q, d->named->q_len) == 0;
  else if (ok) ok = mbedtls_mpi_copy(&q, &d->p) == 0 && mbedtls_mpi_shift_r(&q, 1) == 0;
  if (ok && mbedtls_mpi_cmp_mpi(&q, &bound) < 0) ok = mbedtls_mpi_copy(&bound, &q) == 0;
  ok = ok && mbedtls_mpi_random(priv, 1, &bound, sd_random, NULL) == 0;
  mbedtls_mpi_free(&bound);
  mbedtls_mpi_free(&q);
  return ok;
}

/* generateKeys(encoding): a new key pair, or the public key of the
 * private key the object has. */
static ScrDyn *sd_generate_keys(ScDh *d, const ScrDyn *encoding) {
  mbedtls_mpi priv, pub;
  mbedtls_mpi_init(&priv);
  mbedtls_mpi_init(&pub);
  bool fresh = !d->has_priv;
  bool ok = fresh ? sd_new_private_key(d, &priv) : mbedtls_mpi_copy(&priv, &d->priv) == 0;
  ok = ok && sd_exp(&pub, &d->g, &priv, &d->p);
  if (ok) {
    mbedtls_mpi_swap(&d->priv, &priv);
    mbedtls_mpi_swap(&d->pub, &pub);
    d->has_priv = true;
    d->has_pub = true;
  }
  mbedtls_mpi_free(&priv);
  mbedtls_mpi_free(&pub);
  if (!ok || mbedtls_mpi_cmp_int(&d->pub, 0) == 0) {
    sd_operation_failed("Key generation failed");
    return NULL;
  }
  return sd_encode_value(&d->pub, encoding);
}

/* Whether OpenSSL's DH derivation accepts explicit parameters' private
 * key: a nonzero key and a 512- to 10000-bit prime. */
static bool sd_derives(const ScDh *d) {
  size_t bits = mbedtls_mpi_bitlen(&d->p);
  return mbedtls_mpi_cmp_int(&d->priv, 0) != 0 && bits >= SD_MIN_MODULUS_BITS && bits <= SD_MAX_MODULUS_BITS;
}

/* DH_check_pub_key's subgroup test: under a named group with its own q
 * (the RFC 5114 groups), a peer key must have key^q mod p = 1. The safe
 * prime groups' q is (p - 1) / 2, which OpenSSL does not test. */
static bool sd_in_subgroup(const ScDh *d, const mbedtls_mpi *peer) {
  if (!d->named || !d->named->q) return true;
  mbedtls_mpi q, r;
  mbedtls_mpi_init(&q);
  mbedtls_mpi_init(&r);
  if (mbedtls_mpi_read_binary(&q, d->named->q, d->named->q_len) != 0 || !sd_exp(&r, peer, &q, &d->p))
    scr_trap("scriptc: out of memory\n");
  bool in = mbedtls_mpi_cmp_int(&r, 1) == 0;
  mbedtls_mpi_free(&q);
  mbedtls_mpi_free(&r);
  return in;
}

/* computeSecret(key, inputEncoding, outputEncoding): key^priv mod p,
 * padded to the prime's length. A key outside [2, p - 2], or outside a
 * named group's order-q subgroup, is rejected as DH_check_pub_key does.
 * A secret of 0, 1 or p - 1 is predictable (a peer key of small order,
 * or a composite modulus), so it fails like OpenSSL's derivation does. */
static ScrDyn *sd_compute_secret(ScDh *d, const ScrDyn *key, const ScrDyn *in_enc, const ScrDyn *out_enc) {
  ScrBytes *bytes = ca_key_bytes(SD_SUBJECT, key, in_enc);
  if (!bytes) return NULL;
  ScrDyn *result = NULL;
  mbedtls_mpi peer, bound, secret;
  mbedtls_mpi_init(&peer);
  mbedtls_mpi_init(&bound);
  mbedtls_mpi_init(&secret);
  /* A key longer than p, past its leading zeros, is above p - 1. */
  const unsigned char *data = bytes->data;
  size_t len = bytes->len;
  sd_strip(&data, &len);
  bool longer = len > mbedtls_mpi_size(&d->p);
  if ((!longer && mbedtls_mpi_read_binary(&peer, data, len) != 0) || mbedtls_mpi_sub_int(&bound, &d->p, 1) != 0)
    scr_trap("scriptc: out of memory\n");
  if (!longer && mbedtls_mpi_cmp_int(&peer, 1) <= 0) {
    sd_throw(SCR_ERR_RANGE, "ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too small");
  } else if (longer || mbedtls_mpi_cmp_mpi(&peer, &bound) >= 0) {
    sd_throw(SCR_ERR_RANGE, "ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too large");
  } else if (!sd_in_subgroup(d, &peer)) {
    sd_throw(SCR_ERR_RANGE, "ERR_CRYPTO_INVALID_KEYTYPE", "Supplied key is invalid");
  } else if (!d->has_priv || (!d->group && !sd_derives(d)) || !sd_exp(&secret, &peer, &d->priv, &d->p) ||
             mbedtls_mpi_cmp_int(&secret, 1) <= 0 || mbedtls_mpi_cmp_mpi(&secret, &bound) == 0) {
    sd_operation_failed("Failed to compute shared secret");
  } else {
    size_t len = mbedtls_mpi_size(&d->p);
    ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
    if (mbedtls_mpi_write_binary(&secret, out->data, len) != 0) scr_trap("scriptc: out of memory\n");
    result = ca_encode(SD_SUBJECT, out, out_enc);
  }
  mbedtls_mpi_free(&peer);
  mbedtls_mpi_free(&bound);
  mbedtls_mpi_free(&secret);
  scr_bytes_release(bytes);
  return result;
}

static ScrDyn *sd_get_value(const mbedtls_mpi *value, bool present, const char *missing, const ScrDyn *encoding) {
  if (!present || mbedtls_mpi_cmp_int(value, 0) == 0) {
    sd_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INVALID_STATE", missing);
    return NULL;
  }
  return sd_encode_value(value, encoding);
}

/* setPublicKey(key, encoding) and setPrivateKey(key, encoding). */
static ScrDyn *sd_set_value(mbedtls_mpi *value, bool *present, ScrDyn *self, const ScrDyn *key, const ScrDyn *encoding) {
  ScrBytes *bytes = ca_key_bytes(SD_SUBJECT, key, encoding);
  if (!bytes) return NULL;
  bool held = sd_read(value, bytes);
  scr_bytes_release(bytes);
  if (!held) {
    sd_value_too_long();
    return NULL;
  }
  *present = true;
  return scr_dyn_retain(self);
}

static bool sd_name_is(const char *method, const char *name) {
  return strcmp(method, name) == 0;
}

static ScrDyn *sd_dispatch(ScDh *d, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                           const char *what) {
  const ScrDyn *a0 = sd_arg(args, argc, 0);
  if (sd_name_is(method, "generateKeys")) return sd_generate_keys(d, a0);
  if (sd_name_is(method, "computeSecret"))
    return sd_compute_secret(d, a0, sd_arg(args, argc, 1), sd_arg(args, argc, 2));
  if (sd_name_is(method, "getPrime")) return sd_get_value(&d->p, true, "p is null", a0);
  if (sd_name_is(method, "getGenerator")) return sd_get_value(&d->g, true, "g is null", a0);
  if (sd_name_is(method, "getPublicKey"))
    return sd_get_value(&d->pub, d->has_pub, "No public key - did you forget to generate one?", a0);
  if (sd_name_is(method, "getPrivateKey"))
    return sd_get_value(&d->priv, d->has_priv, "No private key - did you forget to generate one?", a0);
  /* DiffieHellmanGroup has no key setters. */
  if (!d->group && sd_name_is(method, "setPublicKey"))
    return sd_set_value(&d->pub, &d->has_pub, self, a0, sd_arg(args, argc, 1));
  if (!d->group && sd_name_is(method, "setPrivateKey"))
    return sd_set_value(&d->priv, &d->has_priv, self, a0, sd_arg(args, argc, 1));
  /* The Object.prototype methods a DiffieHellman inherits. */
  static const char *const inherited[] = {"constructor",          "hasOwnProperty", "isPrototypeOf",
                                          "propertyIsEnumerable", "toLocaleString", "toString",
                                          "valueOf"};
  for (size_t i = 0; i < sizeof inherited / sizeof inherited[0]; i++)
    if (sd_name_is(method, inherited[i])) {
      static const char message[] = "DiffieHellman's Object.prototype methods have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

/* Every method reads at most three arguments. */
static ScrDyn *sd_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                         const char *what) {
  ScrDyn *unboxed[3] = {NULL, NULL, NULL};
  size_t count = argc < 3 ? argc : 3;
  ScrDyn *result = NULL;
  for (size_t i = 0; i < count; i++)
    if (!(unboxed[i] = ca_unbox(args[i]))) goto done;
  result = sd_dispatch(h, self, method, unboxed, count, what);
done:
  for (size_t i = 0; i < count; i++) scr_dyn_release(unboxed[i]);
  return result;
}

/* verifyError, the one own data property. */
static ScrDyn *sd_get(void *h, const char *key, size_t key_len) {
  ScDh *d = h;
  if (key_len == 11 && memcmp(key, "verifyError", 11) == 0) {
    if (d->verify_error < 0) d->verify_error = sd_check_params(&d->p, &d->g);
    return scr_dyn_new_num(d->verify_error);
  }
  static const char message[] =
    "DiffieHellman property reads other than verifyError have no lowering; call generateKeys(), "
    "computeSecret(), getPrime(), getGenerator(), getPublicKey(), getPrivateKey(), setPublicKey() or "
    "setPrivateKey()";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static bool sd_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  static const char message[] = "Writing DiffieHellman properties has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return true;
}

static ScrDynHandleOps sd_ops = {"DiffieHellman", sd_retain, sd_release, sd_invoke, sd_get, sd_set, NULL, NULL, NULL};
static ScrDynHandleOps sd_group_ops = {"DiffieHellmanGroup", sd_retain, sd_release, sd_invoke, sd_get, sd_set,
                                       NULL, NULL, NULL};
