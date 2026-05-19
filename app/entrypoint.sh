#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Auditor IPs — entrypoint.sh
# Genera certificado TLS autofirmado en el primer arranque.
# El cert y la CA se guardan en /data/certs/ (volumen persistente)
# para que puedas exportar la CA al móvil sin entrar al contenedor.
# ─────────────────────────────────────────────────────────────

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

append_tls_ip() {
    local ip="$1"
    local next_index="$2"

    if [ -z "$ip" ]; then
        return 0
    fi

    if grep -Eq "^IP\.[0-9]+=${ip}$" "$SRV_EXT"; then
        echo "[TLS] IP ya presente en SAN: $ip"
        return 0
    fi

    echo "IP.${next_index}=${ip}" >> "$SRV_EXT"
    echo "[TLS] Añadiendo IP al SAN del certificado: $ip"
}

append_tls_dns_names() {
    local start_index="$1"
    local names="$2"
    local next_index="$start_index"
    local old_ifs="$IFS"

    IFS=", "
    for dns_name in $names; do
        dns_name="$(echo "$dns_name" | tr -d '\r\n\t' | sed 's/^ *//;s/ *$//')"
        if [ -z "$dns_name" ]; then
            continue
        fi
        if grep -Eq "^DNS\.[0-9]+=${dns_name}$" "$SRV_EXT"; then
            echo "[TLS] DNS ya presente en SAN: $dns_name"
            continue
        fi
        echo "DNS.${next_index}=${dns_name}" >> "$SRV_EXT"
        echo "[TLS] Añadiendo DNS al SAN del certificado: $dns_name"
        next_index=$((next_index + 1))
    done

    IFS="$old_ifs"
}

cert_has_required_dns() {
    if [ ! -f "$SRV_CERT" ]; then
        return 1
    fi

    for dns_name in localhost auditor.local auditips.local; do
        if ! openssl x509 -in "$SRV_CERT" -noout -text 2>/dev/null | grep -q "DNS:${dns_name}"; then
            return 1
        fi
    done

    return 0
}

if [ ! -f "$SRV_CERT" ] || [ ! -f "$SRV_KEY" ] || ! cert_has_required_dns; then
    if [ -f "$CA_CERT" ] && [ -f "$CA_KEY" ]; then
        echo "[TLS] Regenerando certificado servidor para actualizar SAN, manteniendo CA existente..."
    else
        echo "[TLS] Generando certificados por primera vez..."
    fi

    # 1. CA raíz (válida 10 años)
    if [ ! -f "$CA_CERT" ] || [ ! -f "$CA_KEY" ]; then
        openssl genrsa -out "$CA_KEY" 4096 >/dev/null 2>&1
        openssl req -new -x509 -days 3650 -key "$CA_KEY" -out "$CA_CERT"         -subj "/C=ES/O=AuditorIPs-LocalCA/CN=AuditorIPs Local CA" >/dev/null 2>&1
    fi

    # 2. Clave del servidor
    openssl genrsa -out "$SRV_KEY" 2048 >/dev/null 2>&1

    # 3. CSR
    openssl req -new -key "$SRV_KEY" -out "$SRV_CSR"         -subj "/C=ES/O=AuditorIPs/CN=auditor.local" >/dev/null 2>&1

    # 4. SAN extension — incluye IPs comunes de LAN + localhost
    cat > "$SRV_EXT" << 'EXTEOF'
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names

[alt_names]
IP.1=127.0.0.1
IP.2=192.168.1.1
IP.3=192.168.1.2
IP.4=192.168.1.10
IP.5=192.168.1.20
IP.6=192.168.1.30
IP.7=192.168.1.40
IP.8=192.168.1.50
IP.9=192.168.1.100
IP.10=192.168.1.101
IP.11=192.168.1.200
IP.12=192.168.1.210
IP.13=192.168.1.252
IP.14=192.168.1.253
IP.15=192.168.1.254
IP.16=10.0.0.1
IP.17=10.0.0.2
IP.18=10.0.0.10
DNS.1=localhost
DNS.2=auditor.local
DNS.3=auditips.local
EXTEOF

    append_tls_dns_names "20" "$TLS_CERT_DNS"

    # Compatibilidad:
    # - nuevo nombre: TLS_CERT_IP
    # - antiguo nombre: SERVER_IP
    append_tls_ip "$TLS_CERT_IP" "99"

    # 5. Firmar con la CA local
    openssl x509 -req -days 3650         -in "$SRV_CSR"         -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial         -out "$SRV_CERT"         -extfile "$SRV_EXT" >/dev/null 2>&1

    # Permisos seguros
    chmod 600 "$CA_KEY" "$SRV_KEY"
    chmod 644 "$CA_CERT" "$SRV_CERT"

    echo "[TLS] ✓ Certificados generados en $CERT_DIR"
    echo "[TLS]   CA raíz para Android: $CA_CERT"
    echo "[TLS]   Copia ca.crt al móvil e instálala en: Ajustes → Seguridad → Instalar certificado"
else
    echo "[TLS] Certificados ya existentes, reutilizando."
fi

echo "[APP] Arrancando Uvicorn en 0.0.0.0:${PORT}"

exec python -m uvicorn main:app     --host 0.0.0.0     --port "$PORT"     --ssl-keyfile "$SRV_KEY"     --ssl-certfile "$SRV_CERT"
