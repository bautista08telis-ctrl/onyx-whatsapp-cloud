/**
 * Plantillas de mensajes de WhatsApp para Onyx / BarberFlow.
 * Compatible con el modelo multi-barbero (member_name), moneda UYU y zona horaria America/Montevideo.
 */

export function normalizeUruguayPhone(phone = "") {
  let digits = String(phone).replace(/[^\d]/g, "");
  if (digits.startsWith("09") && digits.length === 9) {
    digits = "598" + digits.slice(1);
  } else if (
    digits.length === 8 &&
    (digits.startsWith("9") || digits.startsWith("8") || digits.startsWith("7") || digits.startsWith("2") || digits.startsWith("4"))
  ) {
    digits = "598" + digits;
  }
  return digits;
}

export function phoneToJid(phone = "") {
  const clean = normalizeUruguayPhone(phone);
  if (!clean || clean.length < 8) return null;
  return `${clean}@s.whatsapp.net`;
}

export function formatDateTime(isoString, timezone = "America/Montevideo") {
  try {
    const d = new Date(isoString);
    const dateStr = new Intl.DateTimeFormat("es-UY", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(d);
    const timeStr = new Intl.DateTimeFormat("es-UY", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
    return {
      dateStr: dateStr.charAt(0).toUpperCase() + dateStr.slice(1),
      timeStr,
      full: `${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)} a las ${timeStr} hs`,
    };
  } catch {
    return { dateStr: isoString, timeStr: "", full: isoString };
  }
}

export function formatMoney(amount, currency = "UYU") {
  try {
    return new Intl.NumberFormat("es-UY", {
      style: "currency",
      currency: currency || "UYU",
      maximumFractionDigits: Number(amount) % 1 === 0 ? 0 : 2,
    }).format(Number(amount));
  } catch {
    return `$ ${amount}`;
  }
}

export function buildMessage(kind, appointment, barber, appUrl = "https://barberflow-weld.vercel.app") {
  const tz = barber?.timezone || "America/Montevideo";
  const currency = barber?.currency || "UYU";
  const { dateStr, timeStr } = formatDateTime(appointment.start_at, tz);
  const priceStr = formatMoney(appointment.price, currency);
  const shopName = barber?.name || "la Barbería";
  const proName = appointment.member_name && appointment.member_name !== shopName
    ? `\n💈 *Profesional:* ${appointment.member_name}`
    : "";
  const addressLine = barber?.address ? `\n📍 *Dirección:* ${barber.address}` : "";
  const mapsLine = barber?.maps_url ? `\n🗺️ *Mapa:* ${barber.maps_url}` : "";
  const cleanAppUrl = String(appUrl || "").replace(/\/$/, "");
  const manageUrl = appointment.token ? `${cleanAppUrl}/booking/${appointment.token}` : cleanAppUrl;

  if (kind === "reminder") {
    return (
      `¡Hola *${appointment.client_name}*! ⏰\n` +
      `Te recordamos que en *2 horas* tenés turno en *${shopName}*:\n\n` +
      `✂️ *Servicio:* ${appointment.service_name}` +
      proName +
      `\n🕒 *Hora:* ${timeStr} hs (${dateStr})` +
      addressLine +
      `\n\n🔗 *Ver detalles o gestionar cita:*\n${manageUrl}\n\n` +
      `¡Te esperamos! 🙌`
    );
  }

  if (kind === "reminder_1m") {
    return (
      `¡Hola *${appointment.client_name}*! 💈\n` +
      `Tu turno en *${shopName}* comienza en *1 minuto* (*${timeStr} hs*).\n\n` +
      `✂️ *Servicio:* ${appointment.service_name}` +
      proName +
      addressLine +
      `\n\n¡Ya estamos listos para atenderte! 🙌`
    );
  }

  if (kind === "confirmation") {
    return (
      `¡Hola *${appointment.client_name}*! 👋\n` +
      `Tu turno en *${shopName}* quedó *confirmado* ✅\n\n` +
      `✂️ *Servicio:* ${appointment.service_name} (${priceStr})` +
      proName +
      `\n📅 *Fecha:* ${dateStr}` +
      `\n🕒 *Hora:* ${timeStr} hs` +
      addressLine +
      mapsLine +
      `\n\n🔗 *Gestionar o reprogramar tu turno:*\n${manageUrl}`
    );
  }

  if (kind === "rescheduled") {
    return (
      `¡Hola *${appointment.client_name}*! 🔄\n` +
      `Tu turno en *${shopName}* fue *reprogramado* con éxito:\n\n` +
      `✂️ *Servicio:* ${appointment.service_name}` +
      proName +
      `\n📅 *Nueva fecha:* ${dateStr}` +
      `\n🕒 *Nueva hora:* ${timeStr} hs` +
      addressLine +
      `\n\n🔗 *Enlace de tu reserva:*\n${manageUrl}`
    );
  }

  if (kind === "cancelled") {
    return (
      `Hola *${appointment.client_name}*.\n` +
      `Te informamos que tu turno en *${shopName}* para *${appointment.service_name}* (${dateStr} a las ${timeStr} hs) fue *cancelado*.\n\n` +
      `Cuando quieras volver a agendar un nuevo horario, podés hacerlo desde aquí:\n${cleanAppUrl}`
    );
  }

  return (
    `Hola *${appointment.client_name}*, te escribimos de *${shopName}* por tu turno de *${appointment.service_name}* el ${dateStr} a las ${timeStr} hs.`
  );
}

export function buildWaitlistMessage(waitlistEntry, slotTimeStr, barber, appUrl = "https://barberflow-weld.vercel.app") {
  const shopName = barber?.name || "la Barbería";
  const cleanAppUrl = String(appUrl || "").replace(/\/$/, "");
  return (
    `¡Hola *${waitlistEntry.client_name}*! ✨\n` +
    `Se acaba de liberar un lugar en *${shopName}* para el día *${waitlistEntry.date}*` +
    (slotTimeStr ? ` a las *${slotTimeStr} hs*` : "") +
    ` (${waitlistEntry.service_name}).\n\n` +
    `Como te anotaste para que te avisemos si se liberaba un turno, te damos prioridad. ¿Te gustaría que te lo reservemos? Respondé este mensaje o agendalo directo acá:\n${cleanAppUrl}`
  );
}
