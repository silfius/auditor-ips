# Manual de usuario - Auditor IPs

Fecha: 2026-05-19
Estado: primera base documental V4 con capturas iniciales

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

### 4.1 Requisitos

Servidor Linux con:

- Docker;
- Docker Compose;
- Git;
- Python 3;
- permisos para ejecutar Docker;
- puerto web libre;
- espacio suficiente para datos y backups.

Distribuciones objetivo iniciales:

- Debian;
- Ubuntu;
- Arch Linux;
- derivadas razonables.

### 4.2 Instalación recomendada

Clonar el repositorio público y ejecutar el instalador:

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
python3 scripts/install_auditor.py
```

El instalador guía la configuración básica:

- ruta de instalación;
- ruta de datos;
- puerto web;
- nombre del contenedor;
- red principal;
- certificados TLS;
- arranque del stack Docker.

### 4.3 Instalación sin preguntas

Para instalaciones automatizadas, el instalador soporta modo no interactivo con `--yes` y argumentos específicos.

Ejemplo orientativo:

```bash
python3 scripts/install_auditor.py --yes
```

Antes de usarlo en producción conviene revisar la ayuda:

```bash
python3 scripts/install_auditor.py --help
```

### 4.4 Primer acceso

Tras arrancar, acceder desde navegador al puerto configurado, por ejemplo:

```text
https://IP_DEL_SERVIDOR:9909
```

Si el certificado es local o autofirmado, el navegador puede mostrar una advertencia.

### 4.5 Asistente inicial

En una instalación limpia, Auditor IPs muestra un asistente inicial transaccional.

El asistente permite configurar:

- primer usuario administrador;
- red principal;
- intervalo de escaneo;
- retención inicial;
- idioma;
- zona horaria;
- módulos activos;
- notificaciones iniciales.

Nada se aplica hasta confirmar el resumen final.

Si se recarga o se abandona antes de confirmar, el entorno no queda completado parcialmente.

## 5. Actualización / upgrade

### 5.1 Objetivo del upgrade

El flujo de upgrade actualiza una instalación existente conservando configuración local y datos persistentes.

Antes de actualizar una instalación real, se recomienda disponer de backup reciente.

### 5.2 Upgrade guiado

Desde la instalación existente:

```bash
python3 scripts/install_auditor.py --upgrade
```

El instalador de upgrade debe:

- detectar la instalación existente;
- leer configuración local;
- crear backup previo;
- actualizar código;
- validar Docker Compose;
- reconstruir o reiniciar si procede;
- generar resumen de upgrade.

### 5.3 Ficheros locales que no deben subirse a Git

Cada instalación mantiene sus propios ficheros locales:

- `.env`;
- `docker-compose.yml`;
- datos persistentes;
- certificados;
- backups;
- logs;
- tokens;
- claves.

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

### 19.1 No abre la web

Comprobar:

```bash
docker compose ps
docker compose logs --tail=100 auditor_ips
curl -k https://127.0.0.1:9909/api/system/healthz
```

### 19.2 Certificado no confiable

Si se usa certificado local, instalar la CA local en los clientes o aceptar la advertencia de navegador si el entorno es controlado.

### 19.3 El contenedor no arranca

Revisar:

```bash
docker compose config
docker compose logs --tail=200 auditor_ips
```

### 19.4 No aparecen hosts

Revisar:

- red principal CIDR;
- permisos de red;
- firewall;
- conectividad desde el contenedor;
- configuración de escaneo.

### 19.5 No llegan estados de agente

Revisar:

- token correcto;
- URL del servidor;
- TLS/verificación;
- conectividad desde host remoto;
- que el agente exista y esté habilitado en Auditor IPs;
- logs del helper.

### 19.6 Syncthing no muestra datos

Revisar:

- URL API del nodo;
- API key;
- `verify_tls`;
- conectividad;
- estado del refresco backend.

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
