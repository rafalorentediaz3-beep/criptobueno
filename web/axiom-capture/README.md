# MoneyPoly: lector de Axiom conservado

**La fuente activa ahora es Meteora**, con fees acumuladas de al menos **$3.500** y pools creados en los últimos **150 días** al incorporarlos. Los registros se guardan una vez y se acumulan sin renovación ni caducidad. Axiom está en pausa; su implementación, sesión y archivo se conservan. Consulta [RADAR.md](../RADAR.md) para el funcionamiento actual y cómo volver a Axiom.

El resto de este documento describe el modo Axiom. Ese lector usa el motor integrado de Windows WebView2 y funciona en segundo plano, sin Chrome ni permisos de depuración. Puedes cerrar Chrome y la web de MoneyPoly: el lector continúa recogiendo datos mientras el equipo permanezca encendido, sin suspensión y con Internet. No requiere extensiones ni imágenes.

## Uso

1. Ejecuta `npm run dev` desde `web`. Inicia el lector si está detenido y reutiliza el mismo proceso si ya está funcionando.
2. Abre `http://localhost:3000/bot.html`.
3. **Ver Axiom del bot** muestra la ventana integrada; **Segundo plano** la oculta. Cerrar esa ventana con la X también la oculta y mantiene la lectura. El icono de MoneyPoly junto al reloj permite mostrarla o salir del lector.

La sesión se inicia directamente en Axiom y WebView2 la conserva en su propio perfil local de MoneyPoly, separado del de Chrome. El lector no importa ni exporta cookies. Tras reiniciarlo, reutiliza esa sesión. Si Axiom la caduca o solicita una comprobación, MoneyPoly lo indica y muestra su ventana para completar el acceso. No se puede garantizar que Axiom nunca solicite otra verificación.

Cerrar el servidor de la web no detiene el lector. Apagar o suspender el equipo interrumpe la recogida. Después de reiniciar Windows, vuelve a iniciar MoneyPoly; no se ha instalado un servicio de inicio automático de Windows.

## Requisito para el futuro VPS

El despliegue debe mantener el lector de Axiom, su sesión y el archivo de tokens en el VPS, independientemente del portátil y de que alguien tenga la página abierta. La página consultará al servidor y mostrará sus últimas lecturas. La recogida debe continuar mientras el portátil esté apagado.

Todavía no está desplegado ni validado en un VPS. El lector de Axiom requiere Windows con WebView2 y un entorno de escritorio para su ventana de acceso. La fuente activa de Meteora usa HTTP y Node.js, sin esa dependencia de Windows. Para desplegar Axiom hay que validar el acceso desde la IP del VPS, iniciar allí su propia sesión y configurar inicio y recuperación del proceso y almacenamiento persistente.

La página consulta `/api/radar/tokens` en el servidor que la aloja. Esa ruta de Next.js consulta al lector privado del mismo servidor en `127.0.0.1:3001`; el navegador de cada visitante no consulta a su propio portátil. Los controles para mostrar u ocultar la ventana de Axiom solo se muestran en modo Axiom al abrir MoneyPoly desde localhost. El puerto 3001 debe mantenerse privado.

Preparación del arranque en producción, desde `web` y después de instalar las dependencias en el servidor Windows:

```powershell
npm run build
npm run radar:start
```

`radar:start` inicia o reutiliza el lector y sirve la compilación de Next.js. Esto no instala un servicio ni configura el arranque tras un reinicio de Windows. El lector con WebView2 requiere una sesión de escritorio: la recuperación tras reinicio y el acceso remoto deben probarse en el VPS antes de dar el servicio por operativo. No se han cambiado ajustes de acceso remoto ni comprado un servidor.

La aceptación del despliegue requiere apagar el portátil y comprobar desde otro dispositivo que el VPS sigue guardando nuevas lecturas reales de Axiom. Una sesión caducada o una verificación pendiente debe mostrarse como interrupción, sin presentar los últimos valores guardados como datos actuales.

## Control del proceso

Desde `web`:

```powershell
npm run reader:start
npm run reader:status
npm run reader:stop
```

`reader:stop` detiene el lector y conserva el archivo. Los registros están en `web/data/reader-service.log` y `web/data/reader-service-error.log`. El estado incluye `engine: "webview2"`, `requiresChrome: false`, la última lectura válida y el proceso del motor integrado.

El ejecutable se compila localmente desde `scripts/MoneyPolyAxiomHost.cs` usando .NET Framework y el SDK oficial de Microsoft WebView2. Usa el runtime de WebView2 instalado en Windows. No modifica políticas de ejecución, ajustes de Chrome ni verificaciones de seguridad.

## Datos y filtro

El lector consulta **Migrated → Solana → Meteora AMM V2** cada cinco segundos. `web/data/axiom-token-history.json` conserva una fila por contrato durante 30 días desde su última lectura. Los tokens bajo el umbral también se archivan para seguir sus cambios, pero no aparecen como señales válidas.

`pulse-reader.js` lee el campo `feesSol` que Axiom muestra como **Global Fees Paid** y utiliza las funciones de tax y la configuración de visualización de esa sesión de Axiom. No aplica un tax fijo ni estima Global Fees Paid a partir de Meteora. Importa los módulos exactos cargados en la página, incluido su identificador de despliegue.

El filtro solicitado calcula:

```text
Global Fees Paid de Axiom (SOL) × tax / 100 × precio SOL/USD ≥ $500
```

Ese importe calculado no acredita una ganancia personal ni garantiza que todas las fees correspondan al creador. Si el tax es un rango, el filtro utiliza el extremo menor. Si falta el tax, una ruta de conversión o una cotización válida de SOL, no da por cumplido el mínimo. Si Axiom cambia sus módulos y no se pueden validar los campos, el lector lo indica en lugar de inventar valores.

La suscripción de segundo plano usa la función de conexión que incluye Axiom. La recogida cubre los tokens que Pulse va cargando mientras el lector está activo; no recupera automáticamente todo el historial anterior ni garantiza capturar todos los tokens de Axiom. Las fechas del archivo son fechas de lectura. Un token que ya salió del feed conserva su última observación, no una cotización actual garantizada.

## Comprobaciones realizadas el 2 de noviembre de 2026

- El motor integrado superó la comprobación normal de Axiom y cargó Pulse con su propia sesión.
- Entregó lecturas reales de Migrated con fees y taxes distintos por token.
- Las lecturas continuaron con su ventana oculta, mediante una única instancia del motor.
- Después de reiniciar el lector, volvió a recibir datos con su sesión conservada, sin permisos de Chrome.
- El lector anterior de Chrome se sustituyó por `NativeAxiomReader`; el servicio activo no usa CDP ni la autorización de depuración de Chrome.

Los scripts `probe-axiom-*` son diagnósticos anteriores y no se ejecutan al iniciar MoneyPoly. Las pruebas autorizadas con la sesión de Chrome solo la utilizaron en memoria; el lector activo utiliza el acceso realizado directamente en su propio perfil WebView2.

Los cambios y el archivo de tokens permanecen en este equipo. No se suben a GitHub. El perfil de acceso está en `%LOCALAPPDATA%\MoneyPoly\Axiom\<espacio-de-trabajo>` y lo administra WebView2.
