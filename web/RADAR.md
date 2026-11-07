# MoneyPoly / RADAR

## Fuente activa: Meteora

La configuración se guarda en `web/radar.config.json`. El monitor usa directamente la API pública de **Meteora DAMM v2 en Solana**, sin sesión de navegador ni clave API.

El filtro solicitado es:

```text
cumulative_metrics.fees >= 3500 USD
launchpad = met-dbc
social link = websiteUrl OR twitterUsername
fecha de creación del pool entre ahora - 150 días y ahora
```

Son las fees acumuladas desde la creación del pool que devuelve Meteora. No se usa el volumen ni una ventana de 24 horas, no se estima Global Fees Paid de Axiom y no se multiplica otra vez por el tax. La fecha de referencia disponible es `created_at` del pool de Meteora, no una fecha de emisión del contrato. Las fechas ausentes, inválidas o futuras no permiten incorporar un token.

Una fila por contrato: en la primera detección válida se elige el pool de mayores fees entre los recibidos en esa consulta, sin sumar duplicados. Después queda fijado. Se excluyen inicialmente los pools marcados como blacklisted y las monedas de cotización SOL, USDC, USDT y USD1.

La fuente DAMM v2 proporciona pools de negociación. No certifica que un token figure en la columna Migrated de Axiom ni incluye el feed de bonding curves de DBC.

## Actualización y archivo

- La página consulta `/api/radar/tokens` en su propio servidor cada cinco minutos; el botón Actualizar ahora permite una consulta manual.
- En modo Meteora, el lector local pide esa ruta tras cada consulta de cinco minutos. La ruta copia a `meteora_tokens` los registros nuevos que cumplen los filtros; usa `ignoreDuplicates` para no sustituir datos congelados.
- Para guardar desde localhost, configura `SUPABASE_URL` y `SUPABASE_SECRET_KEY` o `SUPABASE_SERVICE_ROLE_KEY` en `web/.env.local`. El monitor indica si Supabase está sincronizado, sin configurar o si hubo un error.
- El lector consulta los pools activos y más recientes con un intervalo objetivo de cinco minutos, sujeto a la respuesta de Meteora.
- El barrido histórico pagina de más reciente a más antiguo y termina al superar la ventana de 150 días. Se inicia al arrancar y se repite 15 minutos después de terminar. Puede tardar varios minutos: su avance aparece en el monitor.
- Los 150 días limitan la incorporación inicial de cada token. La ventana avanza con el tiempo para seguir añadiendo tokens nuevos.
- El archivo automático es `web/data/meteora-direct-token-history.json`, con versión 2 y política `append-only`. Una vez incorporado un contrato, sus fees, pool, fechas y contador no se actualizan. Tampoco se elimina cuando envejece o sus métricas posteriores cambian.
- El archivo no caduca ni se limpia a los 30 o 150 días. Los registros se van acumulando, uno por contrato, también tras reiniciar el lector. Solo se vuelve a escribir el archivo cuando entra un contrato nuevo.
- Recientes selecciona los 50 pools de creación más reciente dentro de los últimos 150 días que ya se han registrado. Archivo conserva todos los registros aceptados, incluso cuando superen esa edad. Ambas pestañas muestran las filas de más recientes a más antiguas según la fecha de creación del pool, con copia del contrato completo.
- La tabla muestra **Creado**, **Guardado** y **Fees al guardar**. Estos valores son una observación histórica fijada; no se presentan como fees actuales. La fecha de «Última comprobación» pertenece al buscador de tokens nuevos, no renueva las fechas de los registros.

Al migrar el archivo anterior, se hace una copia completa en `web/data/meteora-direct-token-history.json.before-150d.json` sin sobrescribir una copia existente. Solo sus registros con pool creado dentro de los 150 días pasan al nuevo archivo acumulativo; se fijan con el último importe que ya tenían almacenado. Los anteriores a esa ventana permanecen en la copia de seguridad. El archivo de Axiom no se modifica.

## X asociado al token y metadata

El lector busca automáticamente el X enlazado al **contrato del token**, según la petición actual. Esto no acredita la identidad personal de su creador. El enlace se obtiene de DEX Screener haciendo coincidir exactamente la cadena Solana y el contrato del token base. No se atribuyen los enlaces de otro token que simplemente use ese contrato como moneda de cotización. Las comunidades de X no se confunden con perfiles personales.

La verificación y los seguimientos se consultan mediante la API pública de **FxTwitter/FxEmbed**, un proveedor externo a X, sin clave ni sesión del navegador. La verificación individual se muestra como tic azul; las verificaciones de organización o gobierno no cuentan como azul. El campo `is_verified` de Meteora no interviene.

La tabla conserva **Todos / Con tic azul / Sin tic azul** y añade **Seguimientos: Sigue a Meteora y Solana / Todos**. Por defecto se requieren ambos seguimientos, respetando después la selección guardada del usuario. Las cuentas objetivo son `@MeteoraAG` (ID `1384042881808166924`) y `@solana` (ID `951329744804392960`); la comprobación compara sus IDs, no menciones en la descripción ni nombres parecidos. Las selecciones funcionan en Recientes y Archivo sin modificar los registros guardados.

Las listas de seguidos se paginan, con un máximo de 20 páginas por consulta. Un seguimiento encontrado se confirma como «Sí». Una ausencia solo se marca como «No» tras llegar al final de la lista. Fallos, respuestas incompletas, límites de paginación y datos ausentes se mantienen como pendientes. Los estados pendientes no pasan los filtros que exigen confirmación; se pueden ver eligiendo «Todos» en ambos selectores.

Cada fila tiene **Info**, que abre la ficha correspondiente al contrato (DEX Screener o Solscan como alternativa). Cuando se obtiene la URI original, también aparece **Meta**, que abre esa metadata. La URI y la descripción se obtienen del reporte público de Rugcheck, comprobando que su campo `mint` coincide exactamente con el contrato. No se descargan automáticamente las URLs arbitrarias de los proyectos. Los perfiles de X se pueden abrir pulsando su usuario.

Los datos complementarios se guardan en `web/data/token-social-metadata.json`, separados del archivo fijo de tokens: sus fees, pool y fechas originales no se renuevan. Los enlaces y la metadata se revisan aproximadamente cada siete días; la verificación y los seguimientos, cada día. Se muestran el origen y la fecha de comprobación. El proceso prioriza los tokens más recientes y completa el resto en segundo plano, sujeto a la disponibilidad de cada proveedor. No es una lectura directa ni instantánea de los servidores de X.

Referencias: [DEX Screener](https://docs.dexscreener.com/api/reference), [FxEmbed](https://docs.fxembed.com/api/introduction/), [seguimientos de FxTwitter](https://docs.fxembed.com/api/twitter/operations/2profilehandlefollowing/), [Rugcheck](https://api.rugcheck.xyz/swagger/index.html).

## Inicio

Desde `web`:

```powershell
npm run dev
npm run reader:status
```

Monitor: `http://localhost:3000/bot.html`. El lector sobrevive al cierre de la página y a los reinicios de Next.js. Se detiene expresamente con `npm run reader:stop`.

Para producción, tras instalar dependencias y compilar:

```powershell
npm run build
npm run radar:start
```

La fuente Meteora usa HTTP y Node.js: no depende de Windows/WebView2. No se ha desplegado en un VPS, que todavía no está configurado. El equipo que ejecute el lector debe permanecer encendido y conectado; el arranque del sistema, el almacenamiento persistente y las comprobaciones remotas se configuran al desplegar.

## Axiom conservado

La implementación WebView2, su sesión propia y `web/data/axiom-token-history.json` se mantienen. El modo Meteora no abre el lector ni modifica el archivo de Axiom.

Para volver al modo anterior, cambia `source` a `axiom` en `web/radar.config.json` y reinicia el lector con `npm run reader:stop` y `npm run reader:start`. Se conserva el filtro previo de Axiom: Global Fees Paid × tax / 100 × SOL/USD ≥ $500. Ese modo sigue requiriendo Windows/WebView2 y una sesión válida de Axiom. La página adapta sus etiquetas, valores, controles y favoritos a la fuente activa.

Documentación de Axiom: [axiom-capture/README.md](axiom-capture/README.md).

API oficial de Meteora: https://damm-v2.datapi.meteora.ag/swagger-ui/

Los cambios y los datos se guardan localmente. No se suben a GitHub.
