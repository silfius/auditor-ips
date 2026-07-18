# Instaladores

Este directorio contiene los componentes específicos de plataforma y el contrato común de prerrequisitos.

## Fuente de verdad

- Requisitos comunes: [`PREREQUISITES.md`](PREREQUISITES.md)
- Instalación guiada Linux: [`../install.sh`](../install.sh)
- Instalador Python Linux: [`../scripts/install_auditor.py`](../scripts/install_auditor.py)
- Instalación Windows: [`windows/README.md`](windows/README.md)
- Manual detallado: [`../docs/INSTALLATION_MANUAL.md`](../docs/INSTALLATION_MANUAL.md)

No existe un segundo instalador Linux dentro de `installers/`: el punto de entrada público y compatible sigue siendo `./install.sh` en la raíz del repositorio.

## Matriz resumida

| Plataforma | Arquitectura | Runtime | Instalación de dependencias |
|---|---|---|---|
| Linux | x86_64/amd64 y arm64/aarch64 | Docker Engine + Compose V2 | Opcional y siempre autorizada |
| Windows 11 | AMD64/x86-64 | Docker Desktop + WSL2 + contenedores Linux | No incluida |

Windows 10, Windows Server y Windows ARM64 están fuera del contrato actual del instalador Windows de Auditor IPs, aunque Docker pueda admitir otros escenarios.
