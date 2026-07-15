# Manual de usuario - Auditor IPs

Fecha: 2026-07-15
Estado: manual V4 alineado con instalador público guiado

## 1. Qué es Auditor IPs

Auditor IPs es una aplicación self-hosted para monitorizar una red local privada.

Permite:

- descubrir hosts de una LAN;
- ver disponibilidad e histórico;
- organizar hosts por tabla, mapa, grupos y ejecuciones;
- diagnosticar calidad de red;
- controlar servicios y aplicaciones internas;
- monitorizar automatizaciones locales o remotas;
- recibir estados desde agentes API;
- supervisar Syncthing Control en modo solo lectura;
- revisar salud interna del propio Auditor IPs;
- gestionar backups, limpieza segura de históricos y mantenimiento de base de datos;
- generar informes HTML imprimibles;
- usar IA opcional para análisis asistidos.

## 2. Público objetivo

Este manual está orientado a:

- usuarios que instalan Auditor IPs desde el repositorio público;
- administradores de pequeñas redes LAN;
- usuarios que quieren entender cada sección de la aplicación;
- mantenedores que necesitan una guía funcional de operación.

No está pensado como documentación interna de desarrollo. Para eso se mantienen `PROMPT_Auditor_IPs.txt`, `INDICE_Auditor_IPs.txt`, `ROADMAP_Auditor_IPs.txt` y `DECISIONES_Y_ERRORES.md`.

## 3. Conceptos básicos

### 3.1 Servidor Auditor IPs

Es el equipo Linux donde se ejecuta Auditor IPs mediante Docker.

Contiene:

- contenedor de aplicación;
- volumen persistente de datos;
- base de datos SQLite;
- certificados TLS locales;
- backups;
- configuración local.

### 3.2 Red principal

Es el rango CIDR principal que Auditor IPs escanea, por ejemplo:

```text
192.168.1.0/24
```

La red principal se usa para descubrir hosts y alimentar el inventario.

### 3.3 Módulos

Auditor IPs está dividido en módulos:

- Dashboard;
- Hosts;
- Calidad;
- Infraestructura / Aplicaciones;
- Infraestructura / Automatizaciones;
- Syncthing Control;
- Configuración;
- Backup / BD;
- Salud del sistema;
- Exportaciones;
- IA opcional;
- Notificaciones.

### 3.4 Agentes API

Los agentes API permiten que scripts remotos envíen estado y logs a Auditor IPs.

El agente no ejecuta comandos remotos desde Auditor IPs. Solo envía información al servidor.

### 3.5 Syncthing Control

Syncthing Control permite observar nodos Syncthing en modo solo lectura.

Auditor IPs no modifica carpetas ni ejecuta acciones remotas sobre Syncthing.

## 4. Instalación desde cero

### 4.1 Qué necesita el usuario

El procedimiento recomendado parte de un equipo Linux conectado a la red que se desea auditar.

Requisito inicial:

- Git, necesario para descargar el repositorio.

El asistente puede detectar e instalar bajo autorización explícita:

- Python 3;
- Docker Engine;
- Docker Compose V2;
- Curl;
- OpenSSL;
- iproute2;
- certificados CA y utilidades básicas.

Plataformas iniciales:

- Debian, Ubuntu, Linux Mint y derivadas razonables;
- Arch Linux, Manjaro y derivadas;
- arquitecturas x86-64 y ARM64.

En otras distribuciones, el asistente realiza el diagnóstico, pero no modifica paquetes automáticamente.

### 4.2 Descarga y arranque del asistente

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
./install.sh
```

El punto de entrada recomendado es `install.sh`. No es necesario ejecutar directamente el script Python.

Antes de instalar, puede comprobar el host:

```bash
./install.sh --check
```

Para autorizar la instalación de dependencias ausentes:

```bash
./install.sh --install-deps
```

El asistente muestra qué paquetes instalará y solicita confirmación antes de usar `sudo`. No guarda ni procesa la contraseña de `sudo`.

Si detecta una instalación Docker existente sin Compose, intenta añadir únicamente el plugin compatible de la distribución. No sustituye paquetes Docker existentes de forma silenciosa. Una migración al repositorio oficial de Docker requiere una autorización específica y muestra previamente los paquetes incompatibles que retiraría. En modo no interactivo, una sustitución potencialmente destructiva se bloquea.

### 4.3 Perfiles del asistente

#### Recomendado

Es el perfil predeterminado. Detecta valores seguros y pregunta únicamente lo necesario.

#### Avanzado

```bash
./install.sh --profile advanced
```

Permite revisar todas las rutas, DNS, identidad de la instancia, cookie, TLS y opciones técnicas.

### 4.4 Preflight

Antes de escribir configuración, muestra una tabla con:

- sistema y arquitectura;
- presencia de Git, Python, Docker y Compose;
- acceso al daemon Docker;
- espacio libre;
- permisos de escritura;
- interfaces IPv4;
- disponibilidad del puerto.

Estados:

- `OK`: comprobación correcta;
- `WARN`: puede continuar, pero requiere revisión;
- `ERROR`: instalación bloqueada.

### 4.5 Selección de interfaz y red

El asistente enumera las interfaces detectadas e indica:

- nombre;
- IP;
- red CIDR;
- ruta por defecto;
- estado;
- si parece física o virtual.

Ejemplo:

```text
1. enp3s0: 192.168.1.20 · red 192.168.1.0/24 · ruta por defecto
2. wlp2s0: 192.168.18.9 · red 192.168.18.0/24
3. macvlan0: 192.168.1.250 · red 192.168.1.0/24 · virtual
```

Debe seleccionarse la interfaz conectada a los dispositivos que se desean auditar. El instalador propone la IP y la red, valida el CIDR e informa del número de direcciones incluidas.

### 4.6 DNS

El asistente clasifica las DNS detectadas como:

- LAN o privadas;
- públicas;
- loopback/stub.

Las DNS loopback, como `127.0.0.53`, no se proponen dentro del contenedor. Se prioriza una DNS de la misma LAN porque una DNS pública normalmente no resuelve nombres internos.

Los dominios de búsqueda vacíos, raíz (`.` o `~.`), direcciones IP y marcadores técnicos de `systemd-resolved` se descartan; solo se trasladan dominios DNS válidos.

### 4.7 Puerto y colisiones

El puerto predeterminado es `9909`. El asistente valida:

- que sea numérico;
- que esté entre 1 y 65535;
- que esté libre;
- que no exista otro contenedor con el mismo nombre.

Si hay un conflicto, debe elegirse otro puerto o cancelar.

### 4.8 Rutas persistentes

Valores habituales:

```text
Código:         ./
Datos:          ./data
Exportaciones:  ./exports
Backups:        ./data/backups
Diagnósticos:   ./diagnostics
```

El asistente crea las rutas, comprueba escritura y valida el espacio disponible. Los backups importantes deben copiarse además a otro equipo o volumen.

### 4.9 Docker y capacidades de red

Auditor IPs usa:

```yaml
network_mode: host
cap_add:
  - NET_ADMIN
  - NET_RAW
```

Son necesarias para descubrimiento LAN, ICMP, ARP y determinadas herramientas de diagnóstico. Estas capacidades amplían el acceso del contenedor a la red del host. Por ello:

- no debe exponerse directamente a Internet;
- debe usarse en LAN o mediante VPN;
- solo debe instalarse desde el repositorio oficial.

El grupo `docker` concede privilegios elevados. El asistente puede usar `sudo docker` sin añadir al usuario al grupo. La incorporación al grupo es opcional y requiere abrir una nueva sesión.

### 4.10 TLS local

La primera ejecución genera:

- una CA local persistente;
- un certificado de servidor cuyo conjunto SAN coincide exactamente con localhost, la IP y el DNS configurados.

Durante un upgrade, el certificado se regenera si conserva SAN antiguos o contiene entradas adicionales no configuradas.

El navegador puede mostrar una advertencia hasta que se confíe en la CA local. La CA pública se guarda en:

```text
data/certs/ca.crt
```

No debe compartirse `ca.key` ni `server.key`.

### 4.11 Construcción, arranque y validación

En una instalación nueva, las opciones recomendadas son:

- construir imagen: sí;
- arrancar servicio: sí;
- validar salud: sí.

La instalación solo se declara correcta si:

- `docker compose config` es válido;
- la imagen se construye;
- el contenedor arranca;
- `/api/system/healthz` responde;
- el certificado contiene los SAN configurados.

Un fallo de salud es bloqueante y el asistente muestra estado y logs.

### 4.12 Instalación no interactiva

Para entornos de prueba:

```bash
./install.sh --yes --install-deps \
  --port 9909 \
  --server-ip 192.168.1.20 \
  --tls-ip 192.168.1.20 \
  --tls-dns auditips.local \
  --scan-cidr 192.168.1.0/24 \
  --data-dir ./data \
  --exports-dir ./exports \
  --backups-dir ./data/backups
```

No se recomienda `--yes` cuando se han realizado cambios manuales en Compose.

### 4.13 Primer acceso

El instalador muestra una URL similar a:

```text
https://IP_DEL_SERVIDOR:9909/login
```

En una base limpia, el asistente web inicial configura:

- primer administrador;
- idioma;
- zona horaria;
- red principal;
- intervalo de escaneo;
- retención;
- módulos;
- notificaciones.

El instalador del host no solicita ni almacena la contraseña del administrador.

## 5. Actualización, rollback, diagnóstico y desinstalación

### 5.1 Upgrade guiado

```bash
./install.sh --upgrade
```

Antes de actualizar:

1. crea un backup SQLite mediante la API de backup;
2. ejecuta `PRAGMA quick_check`;
3. guarda hashes y manifiesto;
4. copia `.env`, Compose y estado;
5. registra el commit anterior.

Después actualiza por `pull --ff-only`, reconcilia la plantilla Compose, reconstruye y exige health y TLS válidos.

Si Compose contiene cambios manuales, el modo interactivo permite conservarlo, regenerarlo o cancelar. El modo `--yes` se detiene para evitar perder cambios.

### 5.2 Rollback

```bash
./install.sh --rollback
```

Antes de detener el servicio valida el manifiesto, los hashes y `PRAGMA quick_check`. Después restaura configuración y base de datos mediante reemplazo atómico, incluso cuando `auditor.db` fue creado por el contenedor y no es escribible por el usuario del host. Si el directorio persistente tampoco permite el reemplazo directo, utiliza un contenedor auxiliar con los mismos volúmenes. Finalmente restaura el commit anterior y exige de nuevo health y TLS válidos.

### 5.3 Diagnóstico

```bash
./install.sh --diagnose
```

Genera un paquete redactado con:

- sistema y arquitectura;
- Docker y Compose;
- estado y logs recientes;
- red y rutas;
- disco;
- configuración sin secretos;
- respuesta de health.

No incluye base de datos, claves privadas, tokens, webhooks ni `.env` en claro. También redacta las salidas de Compose y los logs, utiliza `compose config --no-interpolate` y verifica el contenido antes de comprimirlo.

### 5.4 Desinstalación

```bash
./install.sh --uninstall
```

Modos:

- quitar solo el runtime;
- quitar código conservando datos;
- eliminación completa con doble confirmación.

### 5.5 Ficheros locales que no deben subirse a Git

- `.env`;
- `docker-compose.yml` generado;
- datos persistentes;
- certificados y claves privadas;
- backups;
- diagnósticos sin revisar;
- logs;
- tokens y webhooks.

## 6. Uso diario

### 6.1 Login

![Login](img/login.png)

Auditor IPs es una aplicación privada tras login.

El primer usuario se crea desde el asistente inicial en instalaciones limpias.

### 6.2 Dashboard

![Dashboard](img/dashboard.png)

El Dashboard es la vista inicial tras login.

Muestra un resumen de estado general:

- hosts;
- servicios;
- automatizaciones;
- Syncthing Control;
- salud del sistema;
- procesos activos.

### 6.3 Hosts / Tabla

![Hosts / Tabla](img/hosts-tabla.png)

La tabla de hosts es la vista principal del inventario.

Permite:

- buscar hosts por IP, nombre, MAC, fabricante, responsable o tipo;
- revisar si están online/offline;
- abrir el detalle de un host;
- validar o clasificar dispositivos;
- consultar último cambio relevante;
- asignar responsable o tipo directamente desde la fila;
- agrupar el inventario por responsable, tipo, estado, red o conocido.

La agrupación se gestiona desde el selector `Agrupar por` dentro de la propia tabla, visible en la captura de `Hosts / Tabla`. La antigua vista separada `Hosts / Grupos` ya no existe como subpestaña independiente.

![Hosts / Alertas](img/hosts-alertas.png)

Las alertas de Hosts permiten vigilar cambios relevantes como estado online/offline, cambios de IP o cambios de MAC.



### 6.4 Hosts / Mapa

![Hosts / Mapa](img/hosts-mapa.png)

La vista de mapa ofrece una representación visual de hosts y grupos.

Es útil para entender la distribución general de la red.

### 6.5 Hosts / Ejecuciones

![Hosts / Ejecuciones](img/hosts-ejecuciones.png)

Muestra ejecuciones de escaneo y resultados relacionados.

Sirve para revisar actividad reciente del descubrimiento de red.

### 6.6 Detalle de host

El detalle de host reúne información de un dispositivo:

- estado actual;
- histórico;
- último cambio útil;
- clasificación;
- fingerprint puntual;
- evidencias conocidas.

El resultado puntual del fingerprint no debe confundirse con la clasificación persistida.

## 7. Calidad de red

![Calidad](img/calidad.png)

La sección Calidad permite ejecutar diagnósticos puntuales.

Herramientas usadas:

- ping;
- traceroute o tracepath;
- mtr.

La vista genera:

- resultado técnico;
- informe copiable;
- prompt IA opcional;
- valoración IA si está configurada.

## 8. Infraestructura / Aplicaciones

![Infraestructura / Aplicaciones](img/infra-aplicaciones.png)

Permite monitorizar aplicaciones o servicios internos.

Muestra:

- estado actual;
- histórico;
- disponibilidad;
- eventos recientes.

## 9. Infraestructura / Automatizaciones

![Infraestructura / Automatizaciones](img/infra-automatizaciones.png)

La sección Automatizaciones permite monitorizar scripts y procesos.

Puede recibir estados desde:

- scripts locales;
- carpetas sincronizadas;
- rsync;
- agente API.

Auditor IPs no ejecuta scripts remotos por defecto.

### 9.1 Estados habituales

Estados típicos:

- completed;
- running;
- failed;
- missed;
- stalled.

### 9.2 Alertas

Puede alertar por:

- error;
- proceso demasiado largo;
- proceso perdido;
- script sin actualización;
- incidencias por host y script.

## 10. Agentes API remotos

### 10.1 Para qué sirven

Los agentes API sirven para que un host remoto informe a Auditor IPs del estado de sus scripts.

### 10.2 Alta de agente

En Auditor IPs:

1. Entrar en Configuración.
2. Ir a Procesos / Automatizaciones.
3. Crear agente API para el host remoto.
4. Copiar el token generado.
5. Guardar el token en el host remoto de forma segura.

El token solo debe mostrarse al crear o rotar.

### 10.3 Instalación del agente

En el host remoto:

```bash
python3 scripts/install_auditor_agent.py \
  --server-url https://IP_DEL_SERVIDOR:9909 \
  --host-name NOMBRE_HOST
```

El instalador puede pedir el token de forma interactiva.

También puede instalar un heartbeat systemd opcional.

### 10.4 Uso manual del helper

Una vez instalado:

```bash
auditor-agent-send-status nombre_script completed 0 "mensaje opcional" /ruta/al/log.log
```

Variables útiles:

- `AUDITOR_AGENT_DURATION_SECONDS`;
- `AUDITOR_AGENT_PROGRESS_PCT`;
- `AUDITOR_AGENT_CONFIG`.

## 11. Syncthing Control

![Infraestructura / Syncthing Control](img/infra-syncthing.png)


Syncthing Control integra nodos Syncthing en modo observación.

Permite ver:

- nodos;
- carpetas;
- estado de sincronización;
- transferencias;
- históricos;
- posibles atascos;
- errores de carpeta;
- último cambio relevante por servidor;
- historial de eventos de archivos/carpetas observado.

Privacidad:

- no se guarda la ruta completa local de archivos;
- el origen probable no debe interpretarse como origen garantizado;
- las API keys se almacenan enmascaradas.

## 12. Configuración

![Configuración / Redes](img/config-redes.png)

![Configuración / Apariencia](img/config-apariencia.png)

![Configuración / Interfaz](img/config-interfaz.png)

![Configuración / Notificaciones](img/config-notificaciones.png)

![Configuración / IA](img/config-ia.png)

![Configuración / Procesos](img/config-procesos.png)

![Configuración / Syncthing Control](img/config-syncthing-control.png)

![Configuración / Seguridad](img/config-seguridad.png)

![Configuración / Audit log](img/config-audit-log.png)

![Configuración / Sistema / Salud](img/config-sistema-salud.png)

![Configuración / Documentación](img/config-documentacion.png)

![Configuración / Exportar / Importar](img/config-exportar-importar.png)

![Configuración / Calidad](img/config-calidad.png)


La sección Configuración agrupa opciones de operación.

Áreas habituales:

- Redes;
- Apariencia;
- Interfaz;
- Notificaciones;
- IA;
- Procesos / Automatizaciones;
- Syncthing Control;
- Seguridad;
- Auditoría;
- Backup / BD;
- Sistema / Salud.

## 13. Backup / BD

![Backup / BD](img/config-backup-bd.png)

La zona Backup / BD permite:

- revisar tamaño de BD;
- revisar WAL/SHM;
- revisar uso de `/data`;
- crear backups;
- limpiar backups antiguos;
- estimar limpieza de históricos;
- ejecutar limpieza segura;
- ejecutar VACUUM de forma separada.

Reglas de seguridad:

- antes de borrar debe haber cálculo visible;
- la limpieza real debe crear backup previo;
- no se deben borrar maestros ni configuración;
- VACUUM es acción separada.

## 14. Salud del sistema

Auditor IPs incluye salud interna.

Puede revisar:

- aplicación;
- base de datos;
- almacenamiento;
- backups;
- scheduler;
- scans;
- calidad;
- servicios;
- automatizaciones;
- agentes API;
- Syncthing Control;
- IA;
- notificaciones.

El endpoint público básico es:

```text
/api/system/healthz
```

El endpoint completo está protegido:

```text
/api/system/health
```

## 15. Exportación de informes

Auditor IPs puede generar informe HTML imprimible.

El flujo recomendado para PDF es:

1. Abrir informe HTML.
2. Usar Imprimir del navegador.
3. Seleccionar Guardar como PDF.

## 16. IA opcional

La IA es opcional.

Puede ayudar en:

- análisis de calidad;
- explicación de incidencias;
- interpretación de informes;
- apoyo a diagnóstico.

Las claves API deben tratarse como secretos.

## 17. Notificaciones

Auditor IPs puede notificar eventos relevantes, según configuración.

Ejemplos:

- host nuevo;
- host online/offline;
- servicio caído;
- alertas de scripts;
- calidad degradada;
- Syncthing con posible atasco o error de carpeta.

Discord está soportado para varios tipos de alerta.

## 18. Seguridad y privacidad

Buenas prácticas:

- no publicar `.env`;
- no publicar tokens;
- no publicar API keys;
- no subir backups ni bases de datos;
- no pegar webhooks en chats o documentación;
- proteger acceso al servidor;
- usar red privada o VPN cuando proceda;
- revisar permisos de ficheros de token de agentes.

## 19. Solución de problemas

### 19.1 Diagnóstico recomendado

Ejecuta primero:

```bash
./install.sh --diagnose
```

El paquete resultante permite revisar el host sin compartir secretos.

### 19.2 Dependencias ausentes

```bash
./install.sh --check
./install.sh --install-deps
```

La instalación de paquetes requiere autorización y `sudo`.

### 19.3 No abre la web

```bash
docker compose ps
docker compose logs --tail 150
curl -kfsS https://127.0.0.1:9909/api/system/healthz
```

Comprueba el puerto, firewall, IP seleccionada y estado del contenedor.

### 19.4 Certificado no confiable

Es normal con una CA local. Instala `data/certs/ca.crt` únicamente en dispositivos de confianza. No instales ni compartas las claves privadas.

### 19.5 Puerto ocupado

Repite la instalación con otro puerto:

```bash
./install.sh --port 9910
```

### 19.6 Docker sin permisos

El asistente puede usar `sudo docker`. Si se añade el usuario al grupo `docker`, debe cerrarse y abrirse la sesión. Recuerda que ese grupo concede privilegios elevados.

### 19.7 No aparecen hosts

- confirma la interfaz seleccionada;
- confirma `SCAN_CIDR`;
- verifica que el servidor alcanza la LAN;
- revisa firewall y segmentación VLAN;
- comprueba `NET_RAW` y `NET_ADMIN`.

### 19.8 No se resuelven nombres LAN

Usa el router, Pi-hole o DNS interna. Las DNS públicas normalmente no conocen nombres locales.

### 19.9 Upgrade fallido

No borres `upgrade_backups/`. Ejecuta:

```bash
./install.sh --rollback
```

### 19.10 No llegan estados de agente

- comprueba URL y certificado;
- valida token y host;
- revisa hora del sistema;
- ejecuta el envío de prueba del instalador del agente.

### 19.11 Syncthing no muestra datos

- confirma URL API;
- confirma API key;
- revisa `verify_tls`;
- verifica que el nodo sea accesible desde el servidor.

## 20. Capturas

Este manual incorpora una primera selección de capturas en:

```text
DOC_ONLINE/manual/img/
```

Las capturas proceden de la documentación interna existente y deben revisarse antes de publicar una versión externa del manual.

Pendiente:

- revisar visualmente que no contienen datos sensibles;
- añadir capturas de Syncthing Control si se facilitan o se generan;
- añadir capturas del asistente inicial V2;
- añadir capturas de upgrade/agente si procede.

## 21. Glosario

- **CIDR**: formato de red, por ejemplo `192.168.1.0/24`.
- **Host**: dispositivo detectado en la red.
- **Fingerprint**: identificación puntual de un host.
- **Clasificación persistida**: tipo asignado y guardado para un host.
- **Agente API**: helper remoto que envía estados/logs a Auditor IPs.
- **Healthz**: endpoint simple de salud.
- **WAL/SHM**: ficheros auxiliares de SQLite.
- **Snapshot público**: copia saneada usada para distribución externa.

## 22. Pendientes de ampliación

- Revisar visualmente las capturas copiadas antes de publicar el manual fuera del entorno privado.
- Añadir ejemplos reales por sección.
- Añadir comandos exactos de instalación no interactiva cuando se cierre la sintaxis final.
- Añadir guía de publicación de release estable.
- Añadir sección de recuperación completa desde backup.
- Añadir guía de actualización del agente cliente.
