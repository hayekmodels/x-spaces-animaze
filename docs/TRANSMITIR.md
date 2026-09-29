# Transmitir un X Space en vivo (YouTube / TikTok)

Guía paso a paso para la primera transmisión con OBS. Todo corre en tu PC:

```
Space en Chrome → extensión → relay (PowerShell) → escenario → OBS → YouTube / TikTok
```

> **Permiso:** vas a retransmitir las voces y fotos de otras personas. Avisa en el Space y pide el OK del host y los speakers. Sin eso, un directo puede ser denunciado y retirado.

## 0. Una sola vez

1. **OBS Studio:** descárgalo de [obsproject.com](https://obsproject.com) e instálalo.
2. **Proyecto actualizado** (en PowerShell):
   ```powershell
   cd $HOME\Downloads
   Invoke-WebRequest https://github.com/hayekmodels/x-spaces-animaze/archive/refs/heads/main.zip -OutFile xsa.zip
   Expand-Archive xsa.zip -DestinationPath . -Force
   cd x-spaces-animaze-main
   npm install
   ```
3. **Extensión:** en `chrome://extensions` pulsa ↻ en *X Spaces Active Speaker Probe*. Debe mostrar la última versión.
4. **YouTube:** en [studio.youtube.com](https://studio.youtube.com) → **Crear → Emitir en directo**. La primera vez tarda hasta 24 h en activarse.

## 1. Configurar OBS (una sola vez)

### Ajustes
| Dónde | Qué poner |
|---|---|
| **Ajustes → Emisión** | Servicio **YouTube - RTMPS** → **Conectar cuenta** (o pega la *clave de emisión* de YouTube Studio) |
| **Ajustes → Vídeo** | Resolución base **1920×1080**, resolución de salida **1920×1080**, FPS **30** |
| **Ajustes → Salida** (modo Simple) | Tasa de bits de vídeo **6000 Kbps**, codificador por hardware (NVENC/AMD/QuickSync) si lo tienes, si no x264; tasa de bits de audio **160** |
| **Ajustes → Audio** | Deja el *Audio del escritorio* **desactivado** (así no se cuelan otros sonidos del PC) |

### Escena "Space"
En el panel **Escenas** pulsa **+** y llámala `Space`. Luego en **Fuentes**:

1. **+ → Navegador** (Browser), nombre `Escenario`:
   - URL: `http://127.0.0.1:8787/?title=Libertarios%20de%20verdad` (cambia el título; los espacios se escriben `%20`)
   - Ancho **1920**, Alto **1080**
   - ✅ *Actualizar navegador cuando la escena se active*
   - ❌ *Controlar audio mediante OBS* (desmarcado: el escenario no tiene sonido)
2. **+ → Captura de audio de aplicación** (Application Audio Capture), nombre `Audio del Space`:
   - Ventana: **[chrome.exe]** (la ventana de Chrome donde está el Space)
3. En el **Mezclador de audio**, habla alguien en el Space y comprueba que la barra de `Audio del Space` se mueve (idealmente en amarillo, sin llegar al rojo).

## 2. Cada vez que transmitas

1. **PowerShell:**
   ```powershell
   cd $HOME\Downloads\x-spaces-animaze-main
   npm run relay
   ```
   Déjala abierta todo el directo.
2. **Chrome:** abre el Space, pulsa **Escuchar**, y **expande** el panel de participantes. El panel de la extensión debe decir `Stage relay: connected`.
3. **OBS:** en la escena `Space` deberías ver a los speakers. Si no, clic derecho en `Escenario` → **Actualizar**.
4. **Prueba privada (la primera vez):** en YouTube Studio → **Emitir en directo** → pestaña **Emisión**:
   - Título, descripción, miniatura.
   - Visibilidad **Privado** o **No listado** para la prueba.
5. En OBS pulsa **Iniciar transmisión**. En YouTube Studio verás la vista previa en ~10 s; cuando se vea bien pulsa **Emitir en directo**.
6. Mira el directo desde otro dispositivo (el móvil) para comprobar imagen y sonido.
7. Al terminar: **Finalizar emisión** en YouTube Studio y **Detener transmisión** en OBS.

### Antes de que empiece el Space
Si sales en vivo antes de que haya speakers, el escenario muestra **"EMPEZAMOS PRONTO"** con el título. Puedes cambiar el texto con `&soon=Arrancamos%20a%20las%2020h`.

## 3. TikTok (vertical)

TikTok solo permite directos a cuentas que cumplen sus requisitos (edad y seguidores; mira en la app **+ → LIVE**). Cuando tengas acceso:

1. Consigue **URL del servidor** y **clave** en *LIVE Producer* (tiktok.com) o *TikTok LIVE Studio*.
2. En OBS: **Ajustes → Emisión → Personalizado** con esa URL y clave; **Ajustes → Vídeo → 1080×1920**.
3. Escenario: URL `http://127.0.0.1:8787/?format=vertical&title=...`, ancho **1080**, alto **1920**.

Mientras tanto: graba el formato vertical y sube **clips** a TikTok. Con el plugin **Aitum Vertical** de OBS puedes transmitir en 16:9 a YouTube y grabar a la vez el 9:16.

## Opciones del escenario (se añaden a la URL con `&`)

| Opción | Qué hace |
|---|---|
| `title=…` | Título arriba |
| `format=vertical` | 1080×1920 para TikTok / Shorts |
| `soon=…` | Texto de la pantalla de espera |
| `body=0` | Solo cabezas, sin cuerpos |
| `bg=transparent` | Fondo transparente (para tus propios fondos en OBS) |
| `lang=en` | Textos en inglés |
| `demo=1` | Speakers de prueba (para ensayar sin Space) |

## Problemas frecuentes

| Síntoma | Solución |
|---|---|
| Chrome/OBS: *127.0.0.1 refused to connect* | El relay no está corriendo: `npm run relay` en PowerShell (y pulsa **Enter**). |
| Panel dice `Stage relay: offline` | Igual que arriba; luego recarga el Space con F5. |
| El escenario dice "EMPEZAMOS PRONTO" con el Space abierto | Expande el panel de participantes del Space; recarga con F5. |
| Nadie mueve la boca aunque hablan | En el panel de la extensión mira la fila del que habla: debe decir `SPEAKING`. Si su `bar` es bajo, baja `bar≥` (p. ej. 0.3). |
| Varios hablan a la vez sin hacerlo | Sube `bar≥` (p. ej. 0.45). |
| No se oye en el directo | Mezclador de OBS: `Audio del Space` debe moverse; si no, vuelve a elegir **[chrome.exe]** en la fuente. |
| La imagen va a tirones | OBS → Ajustes → Salida: usa codificador por hardware o baja a 4500 Kbps; cierra pestañas pesadas de Chrome. |
| *Errors* en chrome://extensions sobre `ws://127.0.0.1:8787` | Inofensivo: significa que el relay estuvo apagado en algún momento. |
