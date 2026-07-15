#!/bin/bash

set -euo pipefail

CERT_DIR="/data/certs"
CA_KEY="$CERT_DIR/ca.key"
CA_CERT="$CERT_DIR/ca.crt"
SRV_KEY="$CERT_DIR/server.key"
SRV_CERT="$CERT_DIR/server.crt"
SRV_CSR="$CERT_DIR/server.csr"
SRV_EXT="$CERT_DIR/server.ext"

PORT="${PORT:-9909}"
TLS_CERT_IP="${TLS_CERT_IP:-${SERVER_IP:-}}"
TLS_CERT_DNS="${TLS_CERT_DNS:-auditips.local}"

mkdir -p "$CERT_DIR"

unique_words() {
    printf '%s\n' "$@" | awk 'NF && !seen[$0]++'
}

configured_dns() {
    local old_ifs="$IFS"
    IFS=', '
    # shellcheck disable=SC2086
    unique_words localhost $TLS_CERT_DNS
    IFS="$old_ifs"
}

configured_ips() {
    unique_words 127.0.0.1 "$TLS_CERT_IP"
}

configured_sans() {
    configured_dns | sed 's/^/DNS:/'
    configured_ips | sed 's/^/IP Address:/'
}

certificate_sans() {
    openssl x509 -in "$SRV_CERT" -noout -ext subjectAltName 2>/dev/null       | tail -n +2       | tr ',' '\n'       | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'       | awk 'NF'       | sort -u
}

cert_has_required_sans() {
    [ -f "$SRV_CERT" ] || return 1
    local expected actual
    expected="$(configured_sans | sort -u)" || return 1
    actual="$(certificate_sans)" || return 1
    [ "$expected" = "$actual" ]
}

write_server_extensions() {
    cat > "$SRV_EXT" <<'EXT'
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names

[alt_names]
EXT

    local index=1
    while IFS= read -r ip_value; do
        [ -n "$ip_value" ] || continue
        printf 'IP.%s=%s\n' "$index" "$ip_value" >> "$SRV_EXT"
        index=$((index + 1))
    done < <(configured_ips)

    index=1
    while IFS= read -r dns_name; do
        [ -n "$dns_name" ] || continue
        printf 'DNS.%s=%s\n' "$index" "$dns_name" >> "$SRV_EXT"
        index=$((index + 1))
    done < <(configured_dns)
}

if [ ! -f "$CA_CERT" ] || [ ! -f "$CA_KEY" ]; then
    echo "[TLS] Generando CA local..."
    openssl genrsa -out "$CA_KEY" 4096 >/dev/null 2>&1
    openssl req -new -x509 -days 3650 \
      -key "$CA_KEY" \
      -out "$CA_CERT" \
      -subj "/C=ES/O=AuditorIPs-LocalCA/CN=AuditorIPs Local CA" \
      >/dev/null 2>&1
fi

if [ ! -f "$SRV_CERT" ] || [ ! -f "$SRV_KEY" ] || ! cert_has_required_sans; then
    echo "[TLS] Generando certificado para los SAN configurados..."
    openssl genrsa -out "$SRV_KEY" 2048 >/dev/null 2>&1
    openssl req -new \
      -key "$SRV_KEY" \
      -out "$SRV_CSR" \
      -subj "/C=ES/O=AuditorIPs/CN=${TLS_CERT_DNS%%,*}" \
      >/dev/null 2>&1
    write_server_extensions
    openssl x509 -req -days 3650 \
      -in "$SRV_CSR" \
      -CA "$CA_CERT" \
      -CAkey "$CA_KEY" \
      -CAcreateserial \
      -out "$SRV_CERT" \
      -extfile "$SRV_EXT" \
      >/dev/null 2>&1
    chmod 600 "$CA_KEY" "$SRV_KEY"
    chmod 644 "$CA_CERT" "$SRV_CERT"
    echo "[TLS] Certificados generados en $CERT_DIR"
else
    echo "[TLS] Certificados existentes válidos para la configuración actual."
fi

echo "[APP] Arrancando Uvicorn en 0.0.0.0:${PORT}"
exec python -m uvicorn main:app \
  --host 0.0.0.0 \
  --port "$PORT" \
  --ssl-keyfile "$SRV_KEY" \
  --ssl-certfile "$SRV_CERT"
