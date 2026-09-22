const en = {
  since: "Search from", search: "Search donations", placeholder: "ID, supporter or message", import: "Search LivePix", stop: "Stop search",
  recover: "Retry Subathon donations", resend: "Resend", when: "When", amount: "Amount", supporter: "Supporter", message: "Message", accounting: "Accounting",
  confirmed: "Confirmed by flow", unconfirmed: "No confirmation", anonymous: "Anonymous", noMessage: "No message", flagged: "Flagged by moderation",
  loading: "Loading donations", empty: "No donations found", more: "Load more", retry: "Try again", failed: "Could not load donations.",
  help: "The plugin applies its Subathon start date to every retry. Keep the original event key in Register Donate to avoid counting twice.",
  receipt: "Add Confirm accounting after Register Donate to show confirmation here. No confirmation does not mean the donation was not counted.",
  dateRequired: "Choose a valid start date.", imported: "New donations saved", existing: "Already saved", invalid: "Invalid records skipped", importing: "Reading LivePix history", complete: "Search completed", stopped: "Search stopped",
  importFailed: "Search interrupted. Saved donations are kept. Try again to continue; check LivePix credentials if the error persists.",
  offline: "Connect the LivePix plugin and try again.", inactive: "Enable this webhook first.", sendFailed: "Could not send. Try again.",
  sent: "Sent to the connected plugin. Accounting confirmation is shown separately.", recoverySent: "Recovery requested. The plugin will retry donations from its Subathon start date.", resent: "Last resend",
};
type Copy = { [K in keyof typeof en]: string };
const pt: Copy = {
  since: "Buscar a partir de", search: "Buscar doações", placeholder: "ID, apoiador ou mensagem", import: "Buscar no LivePix", stop: "Parar busca",
  recover: "Reenviar doações do subathon", resend: "Reenviar", when: "Quando", amount: "Valor", supporter: "Apoiador", message: "Mensagem", accounting: "Contabilização",
  confirmed: "Confirmada pelo fluxo", unconfirmed: "Sem confirmação", anonymous: "Anônimo", noMessage: "Sem mensagem", flagged: "Marcada pela moderação",
  loading: "Carregando doações", empty: "Nenhuma doação encontrada", more: "Carregar mais", retry: "Tentar novamente", failed: "Não foi possível carregar as doações.",
  help: "O plugin respeita o início do subathon em cada reenvio. Mantenha a chave original em Registrar Donate para evitar contagem duplicada.",
  receipt: "Adicione Confirmar contabilização após Registrar Donate para mostrar a confirmação aqui. Sem confirmação não significa que a doação não foi contada.",
  dateRequired: "Escolha uma data de início válida.", imported: "Novas doações salvas", existing: "Já salvas", invalid: "Registros inválidos ignorados", importing: "Buscando histórico do LivePix", complete: "Busca concluída", stopped: "Busca interrompida",
  importFailed: "A busca falhou. As doações salvas foram mantidas. Tente novamente para continuar; se o erro persistir, confira as credenciais do LivePix.",
  offline: "Conecte o plugin LivePix e tente novamente.", inactive: "Ative este webhook primeiro.", sendFailed: "Não foi possível enviar. Tente novamente.",
  sent: "Enviado ao plugin conectado. A confirmação de contabilização aparece separadamente.", recoverySent: "Recuperação solicitada. O plugin reenviará as doações desde o início do subathon configurado nele.", resent: "Último reenvio",
};
const es: Copy = {
  since: "Buscar desde", search: "Buscar donaciones", placeholder: "ID, colaborador o mensaje", import: "Buscar en LivePix", stop: "Detener búsqueda",
  recover: "Reenviar donaciones del subathon", resend: "Reenviar", when: "Cuándo", amount: "Importe", supporter: "Colaborador", message: "Mensaje", accounting: "Contabilización",
  confirmed: "Confirmada por el flujo", unconfirmed: "Sin confirmación", anonymous: "Anónimo", noMessage: "Sin mensaje", flagged: "Marcada por moderación",
  loading: "Cargando donaciones", empty: "No se encontraron donaciones", more: "Cargar más", retry: "Reintentar", failed: "No se pudieron cargar las donaciones.",
  help: "El plugin respeta el inicio del subathon en cada reenvío. Mantén la clave original en Registrar Donate para evitar duplicados.",
  receipt: "Añade Confirmar contabilización después de Registrar Donate para mostrar la confirmación aquí. Sin confirmación no significa que no se haya contado.",
  dateRequired: "Elige una fecha de inicio válida.", imported: "Nuevas donaciones guardadas", existing: "Ya guardadas", invalid: "Registros inválidos omitidos", importing: "Buscando historial de LivePix", complete: "Búsqueda completada", stopped: "Búsqueda detenida",
  importFailed: "La búsqueda falló. Las donaciones guardadas se conservan. Reintenta para continuar; si persiste el error, revisa las credenciales de LivePix.",
  offline: "Conecta el plugin LivePix y vuelve a intentarlo.", inactive: "Activa este webhook primero.", sendFailed: "No se pudo enviar. Vuelve a intentarlo.",
  sent: "Enviado al plugin conectado. La confirmación de contabilización se muestra por separado.", recoverySent: "Recuperación solicitada. El plugin reenviará las donaciones desde el inicio del subathon configurado.", resent: "Último reenvío",
};
const zh: Copy = {
  since: "搜索起始时间", search: "搜索捐赠", placeholder: "ID、支持者或留言", import: "查询 LivePix", stop: "停止搜索",
  recover: "重新发送马拉松捐赠", resend: "重新发送", when: "时间", amount: "金额", supporter: "支持者", message: "留言", accounting: "计入状态",
  confirmed: "流程已确认", unconfirmed: "尚未确认", anonymous: "匿名", noMessage: "无留言", flagged: "已被审核标记",
  loading: "正在加载捐赠", empty: "未找到捐赠", more: "加载更多", retry: "重试", failed: "无法加载捐赠。",
  help: "插件会在每次重发时遵守马拉松起始时间。请在 Registrar Donate 中保留原始事件键，避免重复计入。",
  receipt: "在 Registrar Donate 之后添加确认计入操作，即可在此显示确认。尚未确认并不代表未计入。",
  dateRequired: "请选择有效的起始日期。", imported: "新保存的捐赠", existing: "已保存", invalid: "已跳过无效记录", importing: "正在查询 LivePix 历史", complete: "搜索完成", stopped: "搜索已停止",
  importFailed: "搜索失败，已保存的捐赠仍会保留。请重试以继续；如果问题持续，请检查 LivePix 凭据。",
  offline: "请连接 LivePix 插件后重试。", inactive: "请先启用此 webhook。", sendFailed: "无法发送，请重试。",
  sent: "已发送给连接的插件。计入确认会单独显示。", recoverySent: "已请求恢复。插件将从所配置的马拉松起始时间开始重新发送捐赠。", resent: "上次重发",
};
export function donationRecoveryCopy(locale = document.documentElement.lang): Copy {
  if (locale.startsWith("pt")) return pt;
  if (locale.startsWith("es")) return es;
  if (locale.startsWith("zh")) return zh;
  return en;
}
