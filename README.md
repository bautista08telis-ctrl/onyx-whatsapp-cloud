# 💈 Onyx WhatsApp PC — Motor Open-Source Gratuito (`@whiskeysockets/baileys`)

Este programa independiente permite enviar **confirmaciones, recordatorios (2 horas antes), reprogramaciones y cancelaciones de turnos por WhatsApp de forma 100% gratuita desde tu PC**, utilizando un chip/número nuevo sin pagar por mensaje a la API de Meta ni requerir verificación empresarial.

> **100% independiente:** No modifica ningún archivo de tu aplicación web en Next.js ni de Vercel. Se conecta directamente a tu base de datos de **Supabase** y sincroniza los estados de entrega (`Enviado`, `Entregado`, `Leído`) con la tabla `public.notification_jobs` y `public.appointments`.

---

## 🚀 Cómo se conecta con la nueva arquitectura de Onyx (Cambios de Codex)

1. **Soporte Multi-Profesional (`team_members`):**
   Lee automáticamente `member_name` de cada cita en `public.appointments` para indicar en el WhatsApp con qué profesional se agendó el cliente.
2. **Bandeja de salida durable (`public.notification_jobs`):**
   - Reclama y procesa trabajos pendientes mediante el RPC `claim_notification_jobs(['whatsapp'])`.
   - Además, monitorea en tiempo real (`postgres_changes` + ciclo cada 20s) la tabla `public.appointments`.
   - Cuando envía un WhatsApp y el teléfono del cliente confirma recepción (`DELIVERY_ACK`) o lectura (`READ`), actualiza `delivery_status = 'delivered'` o `'read'` en `public.notification_jobs`, por lo que podrás verlo también en `/admin/settings` en tu web.
3. **Baja automática (`BAJA` / `STOP`):**
   Igual que el webhook oficial de Meta (`src/app/api/webhooks/whatsapp/route.ts`), si un cliente responde `BAJA`, `STOP` o `CANCELAR RECORDATORIOS`, el programa actualiza `whatsapp_opt_in = false` en `public.appointments` de Supabase y no vuelve a enviarle recordatorios.

---

## 🛠️ Cómo iniciarlo en tu PC con tu número nuevo

1. Coloca el chip nuevo en un celular y activa WhatsApp normalmente.
2. Entra a la carpeta `onyx-whatsapp-pc` y haz doble clic en **`INICIAR-WHATSAPP.bat`** (o ejecuta `npm install` y `npm start`).
3. Se abrirá automáticamente el **Panel de Control Local** en **[http://localhost:3005](http://localhost:3005)**.
4. En el celular del número nuevo, abre WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo** y escanea el código QR que aparece en pantalla.
5. ¡Listo! La sesión queda guardada en la carpeta `auth_session/` para que no tengas que volver a escanear el QR cuando apagues o reinicies la PC.

---

## 🛡️ Protección Anti-Bloqueo (Anti-Ban) incluida para tu chip nuevo

- **Simulación de escritura humana:** Antes de cada mensaje, el bot se suscribe a la presencia del contacto y muestra el estado *"escribiendo..."* durante 2 a 4 segundos.
- **Pausas aleatorias (Jitter):** Deja entre 4 y 8 segundos aleatorios entre un mensaje y otro si entran varias reservas juntas.
- **Verificación previa:** Comprueba mediante `sock.onWhatsApp()` que el número uruguayo (`5989...`) tenga WhatsApp activo antes de enviar.
- **Consejo para el chip recién comprado:** Durante los primeros 2 o 3 días de activar el chip nuevo, envíate algunos mensajes de ida y vuelta con tu propio número personal o de amigos (texto, algún audio o sticker) para que WhatsApp registre actividad humana natural en la línea nueva.
