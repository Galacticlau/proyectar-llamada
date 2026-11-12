# Llamada para proyectar

Simulador de llamadas entrantes con un panel de administración y una pantalla de proyección sincronizada.

## Uso

Las pantallas de 4° Medio tienen los accesos cortos `/4A`, `/4B` y `/4C`. En el proyector, pulsa **Conectar este proyector** y escribe el código en **Conectar proyector** en Administración del curso correspondiente. También puedes abrir directamente la pantalla desde Administración. La misma pestaña recuerda el acceso al recargar.

1. En `/admin`, ingresa la clave de administración.
2. Carga los archivos de audio. Puedes editar el nombre de cada llamada, ordenar los pendientes y copiar el enlace directo a cada grabación.
3. Abre la pantalla de usuario desde Administración. En el computador conectado al proyector, pulsa **Activar sonido** una vez y, si quieres, **Pantalla completa**.
4. Pulsa **Lanzar siguiente llamada** desde Administración. La pantalla puede contestar, rechazar o posponer. Posponer hace que la misma llamada vuelva a sonar tras 5 segundos. Si se rechaza, el admin puede volver a llamar.
5. Cuando el navegador confirma que terminó la grabación, se marca como reproducida. La lista queda en espera hasta que el admin lance la siguiente llamada.
6. Después de un ensayo, pulsa **Volver a empezar** en Administración para dejar todas las grabaciones pendientes en su orden actual.

La pantalla de proyección descarga la próxima grabación completa antes de habilitar la llamada. Mantén abierta esa pantalla y espera el aviso de que la grabación está lista. Si la conexión se interrumpe durante la reproducción, el archivo local puede terminar y la confirmación se envía al reconectar.

Para una videollamada, carga un MP4 de hasta 300 MiB en **Cargar videos**. Los videos comparten la lista con los audios y aparecen dentro del teléfono al contestar. Los enlaces directos a videos usan una dirección estable que genera un acceso temporal al archivo.

El enlace de proyección permite responder a las llamadas de esta sala. Cada enlace directo de audio permite escuchar esa grabación a quien lo tenga. Comparte los enlaces con las personas que deben usarlos.

## Despliegue

Requiere Node.js 22 o superior y PostgreSQL. En Railway, conecta este repositorio y agrega:

- `DATABASE_URL`, con la referencia al servicio PostgreSQL, por ejemplo `${{Postgres.DATABASE_URL}}`.
- `APP_ADMIN_KEY`, una clave aleatoria de al menos 16 caracteres. Cambiarla también cambia el enlace de proyección.
- `APP_ADMIN_KEY_4A`, `APP_ADMIN_KEY_4B` y `APP_ADMIN_KEY_4C`, claves distintas de al menos 16 caracteres para las tres salas de 4° Medio. Cada clave abre su propia lista, fondo y pantalla de proyección. La clave anterior sigue abriendo la sala que contiene las grabaciones previas.
- Para habilitar videos, referencia el bucket privado con `VIDEO_BUCKET`, `VIDEO_ENDPOINT`, `VIDEO_REGION`, `VIDEO_ACCESS_KEY_ID` y `VIDEO_SECRET_ACCESS_KEY`. Define `VIDEO_PATH_STYLE=true` si el servidor S3 requiere URLs por ruta.

Railway provee `PORT`. La aplicación usa `npm start` y prepara el esquema al arrancar. PostgreSQL guarda la cola, los audios, el fondo y las referencias a los videos. El bucket guarda los MP4. Para desarrollo local, configura las mismas variables y ejecuta `npm ci` y `npm start`.
