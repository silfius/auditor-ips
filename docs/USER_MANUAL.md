# Manual de usuario de Auditor IPs

Este manual comienza cuando el servicio ya está instalado y accesible. Para crear un nuevo site, consulta [`INSTALL.md`](INSTALL.md) y [`INSTALLATION_MANUAL.md`](INSTALLATION_MANUAL.md).

## 1. Qué es Auditor IPs

Auditor IPs es una aplicación self-hosted para inventariar y supervisar una red privada. Centraliza:

- descubrimiento y clasificación de hosts;
- disponibilidad e histórico de cambios;
- calidad de red;
- aplicaciones y servicios internos;
- automatizaciones locales o remotas;
- agentes API;
- observación de Syncthing;
- salud del propio sistema;
- backups, retención y mantenimiento;
- informes y notificaciones opcionales.

Auditor IPs está diseñado para LAN o VPN, no para exposición directa a Internet.

## 2. Conceptos básicos

### Site

Un site es una instalación independiente con su propia identidad, base, certificados, configuración, red y usuarios. Cada site debe usar valores únicos para `AUDITOR_INSTANCE_ID` y `SESSION_COOKIE_NAME`.

### Host

Un host es un dispositivo detectado o registrado en la red. Puede tener IP, MAC, nombre, fabricante, estado, responsable, tipo e histórico.

### Red principal

Es el rango CIDR que se audita, por ejemplo:

```text
192.168.1.0/24
```

### Fingerprint y clasificación

Un fingerprint es una inferencia puntual basada en evidencias. La clasificación persistida es el tipo que queda guardado para el host; no deben confundirse.

### Agente API

Es un helper que envía estados desde un host remoto. No habilita ejecución remota de comandos desde Auditor IPs.

## 3. Primer acceso

Abre la URL mostrada por el instalador:

```text
https://IP_O_DNS:PUERTO/login
```

En una instalación limpia, el asistente inicial permite:

1. crear el primer administrador;
2. elegir idioma y zona horaria;
3. revisar red y retención;
4. habilitar módulos;
5. configurar notificaciones opcionales.

La contraseña no se almacena en `.env`.

El certificado inicial procede de una CA local. Instala únicamente el certificado público de esa CA en dispositivos de confianza.

## 4. Dashboard

El Dashboard resume el estado general del site:

- hosts conocidos y activos;
- servicios o aplicaciones supervisados;
- automatizaciones;
- Syncthing Control;
- salud interna;
- procesos o incidencias recientes.

Úsalo como punto de entrada, pero abre el módulo correspondiente para revisar el detalle y el histórico.

## 5. Hosts

### Tabla

La tabla principal permite:

- buscar por IP, nombre, MAC, fabricante, responsable o tipo;
- distinguir online y offline;
- abrir la ficha del dispositivo;
- validar o modificar su clasificación;
- asignar responsable y tipo;
- revisar el último cambio útil;
- agrupar por responsable, tipo, estado, red o conocimiento.

Antes de modificar una clasificación automática, revisa sus evidencias y el histórico.

### Alertas

Las alertas de hosts pueden señalar:

- alta de un dispositivo;
- transición online/offline;
- cambio de IP;
- cambio de MAC;
- otras variaciones relevantes configuradas.

### Mapa

El mapa representa relaciones o agrupaciones de hosts para facilitar una lectura visual de la red. No sustituye la tabla ni implica topología física exacta.

### Ejecuciones

La vista de ejecuciones registra actividad de descubrimiento y sus resultados. Es útil para comprobar cuándo se actualizó el inventario y detectar fallos recurrentes.

### Detalle de host

La ficha reúne:

- estado e identidad actuales;
- histórico;
- clasificación persistida;
- último fingerprint;
- evidencias conocidas;
- cambios y alertas relacionadas.

## 6. Calidad de red

La sección Calidad ejecuta diagnósticos puntuales como:

- ping;
- traceroute o tracepath;
- MTR.

Los resultados pueden incluir salida técnica, resumen copiable y análisis asistido opcional. Una medición puntual no equivale a una garantía permanente de calidad.

## 7. Infraestructura y aplicaciones

Permite registrar servicios o aplicaciones internas y revisar:

- estado actual;
- disponibilidad;
- eventos recientes;
- histórico de comprobaciones.

Configura intervalos razonables para no generar carga innecesaria sobre la red o los destinos.

## 8. Automatizaciones

Auditor IPs puede recibir estados desde:

- scripts locales;
- carpetas sincronizadas;
- agentes API;
- integraciones propias.

Estados habituales:

- `running`;
- `completed` o `success`;
- `failed` o `error`;
- `missed`;
- `stalled`.

Las alertas pueden detectar errores, ejecuciones demasiado largas, ausencia de actualización o procesos perdidos.

La integración técnica está en [`SCRIPTS_INTEGRATION.md`](SCRIPTS_INTEGRATION.md).

## 9. Agentes API remotos

### Alta

1. Abre Configuración → Procesos/Automatizaciones.
2. Crea un agente para el host remoto.
3. Copia el token mostrado.
4. Guárdalo de forma restringida en el host remoto.

### Instalación del helper

```bash
python3 scripts/install_auditor_agent.py \
  --server-url https://IP_O_DNS:9909 \
  --host-name NOMBRE_HOST
```

Consulta la sintaxis actual:

```bash
python3 scripts/install_auditor_agent.py --help
```

### Envío manual

```bash
auditor-agent-send-status nombre_script completed 0 "mensaje opcional" /ruta/al/log.log
```

Rota el token si pudo aparecer en una consola, captura o log.

## 10. Syncthing Control

El módulo observa nodos Syncthing en modo de lectura. Puede mostrar:

- nodos y carpetas;
- estado de sincronización;
- transferencias;
- históricos;
- errores de carpeta;
- posibles atascos;
- último cambio relevante.

Auditor IPs no debe interpretarse como origen garantizado de un fichero ni como herramienta para modificar remotamente carpetas Syncthing.

## 11. Configuración

Las áreas disponibles pueden incluir:

- Redes;
- Apariencia e interfaz;
- Notificaciones;
- IA opcional;
- Procesos y automatizaciones;
- Syncthing Control;
- Seguridad y sesiones;
- Auditoría;
- Backup/BD;
- Sistema y salud.

Los cambios de infraestructura del host —puerto, rutas, Docker, TLS— se gestionan fuera de la UI mediante el instalador o los ficheros locales. Consulta [`CONFIGURATION.md`](CONFIGURATION.md).

## 12. Backup y base de datos

La zona de backup y BD permite, según versión y permisos:

- revisar tamaño de la base y ficheros WAL/SHM;
- crear backups consistentes;
- aplicar retención de backups;
- estimar la limpieza de históricos;
- ejecutar limpieza segura;
- ejecutar `VACUUM` como acción separada.

Reglas:

- revisa siempre el cálculo previo;
- conserva una copia fuera del host;
- no copies una SQLite activa de forma parcial;
- no borres maestros o configuración para reducir espacio;
- verifica el backup antes de depender de él.

Consulta [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md).

## 13. Salud del sistema

El endpoint básico es:

```text
/api/system/healthz
```

La vista completa puede revisar aplicación, base, almacenamiento, backups, scheduler, scans, calidad, servicios, automatizaciones, agentes, Syncthing, IA y notificaciones.

Un `healthz` correcto demuestra que el servicio responde; no sustituye la comprobación funcional de login y datos.

## 14. Informes

Los informes HTML pueden imprimirse desde el navegador:

1. abre el informe;
2. selecciona Imprimir;
3. usa Guardar como PDF.

Revisa el contenido antes de compartirlo: puede contener nombres, IP y detalles de la red.

## 15. IA opcional

La IA puede apoyar la interpretación de calidad, incidencias o informes. No es necesaria para el funcionamiento principal.

- trata las claves API como secretos;
- revisa qué datos se envían al proveedor;
- no sustituyas una comprobación técnica por una explicación generada.

## 16. Notificaciones

Según configuración, pueden notificarse:

- hosts nuevos;
- cambios online/offline;
- servicios caídos;
- errores de automatizaciones;
- calidad degradada;
- incidencias de Syncthing.

Evita incluir secretos o datos excesivos en webhooks y mensajes externos.

## 17. Operación diaria recomendada

- Revisa el Dashboard y las alertas.
- Investiga cambios de identidad antes de validarlos.
- Comprueba backups y espacio disponible.
- Mantén Docker y el host actualizados.
- Ejecuta diagnósticos antes de modificar la instalación.
- Conserva la documentación y el repositorio en el mismo commit que el código instalado.

## 18. Seguridad y privacidad

No publiques:

- `.env`;
- bases y backups;
- tokens o webhooks;
- cookies o sesiones;
- claves privadas;
- logs o informes sin revisar.

Usa LAN o VPN, limita el acceso al host y aplica el principio de mínimo privilegio.

## 19. Ayuda

Para incidencias técnicas consulta [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md). Al abrir una incidencia incluye plataforma, commit, método de instalación, primer error y diagnóstico redactado.

## 20. Glosario

- **CIDR:** rango de red, por ejemplo `192.168.1.0/24`.
- **Host:** dispositivo registrado o detectado.
- **Site:** instancia independiente de Auditor IPs.
- **Fingerprint:** inferencia puntual sobre un host.
- **Agente API:** helper autenticado que envía estados.
- **Healthz:** comprobación básica de disponibilidad.
- **WAL/SHM:** ficheros auxiliares de SQLite.
- **Snapshot público:** copia saneada destinada a distribución externa.
