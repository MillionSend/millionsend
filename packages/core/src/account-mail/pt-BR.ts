import type { AccountMailEntry, AccountMailKind, MailPhraseKey } from "../account-mail.js";

export const ptBR = {
  welcome: {
    subject: "Bem-vindo ao MillionSend",
    body: [
      "Olá, {name}, sua conta está pronta.",
      "Primeiro adicione um domínio de envio e publique os registros DNS; os envios saem assim que ele verificar.",
      "Depois crie uma chave de API em Chaves de API — ela aparece uma única vez e é o que os SDKs, o SMTP e o servidor MCP usam para enviar.",
    ],
    button: "Adicionar domínio",
    muted: ["Documentação: {docsUrl}"],
  },
  password_changed: {
    subject: "Sua senha do MillionSend foi alterada",
    body: [
      "A senha de {email} acabou de ser alterada e as outras sessões foram encerradas.",
      "Se foi você, não há nada a fazer. Se não foi, redefina agora — isso encerra a sessão de quem fez — e revise suas chaves de API e apps conectados.",
    ],
    button: "Redefinir senha",
  },
  "mcp.connected": {
    subject: "{app} foi conectado à sua conta do MillionSend",
    body: [
      "Você permitiu que {app} atue em {team} pelo servidor MCP do MillionSend com estas permissões: {scopes}.",
      "Ele pode fazer ali o que você pode, em seu nome, até você revogar.",
    ],
    button: "Revisar apps conectados",
    muted: ["Não autorizou isso? Revogue agora."],
    extra: { allTeams: "todas as suas equipes" },
  },
  "api_key.created": {
    subject: "Nova chave de API em {team}: {name}",
    body: [
      '{actor} criou a chave de API "{name}" ({prefix}…{last4}, {permission}{scope}) em {team}.',
      "Quem tiver a chave pode enviar pelos domínios verificados da equipe. Não esperava isso? Revogue em Chaves de API.",
    ],
    button: "Abrir chaves de API",
    extra: {
      scope: ", limitada a {domain}",
      full_access: "acesso total",
      sending_access: "acesso de envio",
      apiKeyActor: "uma chave de API",
      mcpActor: "um cliente MCP",
      systemActor: "o MillionSend",
    },
  },
  "webhook.secret_rotated": {
    subject: "Segredo do webhook {host} rotacionado",
    body: ["{actor} rotacionou o segredo de assinatura de {url} em {team}.", "{deadline}"],
    button: "Abrir endpoint",
    extra: {
      overlap:
        "O segredo anterior continua válido até {until}; troque no receptor antes disso ou as entregas passam a falhar.",
      immediately:
        "O segredo anterior deixou de valer na hora; as entregas falham até o receptor usar o novo.",
    },
  },
  "member.joined": {
    subject: "{name} entrou em {team}",
    body: [
      "{name} ({email}) aceitou o convite e agora é {role} de {team}.",
      "Membros enviam e leem os logs; administradores também gerenciam domínios, chaves e webhooks. Remova em Configurações → Equipe se estiver errado.",
    ],
    button: "Abrir configurações da equipe",
    extra: { member: "membro", admin: "administrador", owner: "proprietário" },
  },
  "domain.verified": {
    subject: "{domain} está verificado",
    body: [
      "Os registros DNS de {domain} estão corretos e ele pode enviar de qualquer endereço — API, SMTP e broadcasts.",
      "Continuamos verificando os registros e avisamos se algum sumir.",
    ],
    button: "Abrir domínio",
  },
  "domain.lost": {
    subject: "{domain} perdeu a verificação",
    body: [
      "Um registro DNS obrigatório de {domain} (DKIM ou MAIL FROM) deixou de responder, então os envios são recusados até ele voltar — chamadas à API falham e broadcasts agendados param na hora do envio.",
      "Restaure o registro no seu DNS; a verificação volta sozinha na próxima checagem ou quando você clicar em Verificar.",
    ],
    button: "Abrir domínio",
  },
  "domain.lost.identity": {
    subject: "{domain} perdeu a verificação",
    body: [
      "O SES desistiu de {domain}: a identidade sumiu ou os registros DKIM ficaram ausentes além da janela de 72 horas. Os envios são recusados; adicione o domínio de novo para voltar a enviar.",
    ],
    button: "Abrir domínios",
  },
  "broadcast.sent": {
    subject: '"{name}" foi enviado para {count} destinatários',
    body: [
      '"{subject}" foi entregue a {count} contatos de {team}; endereços suprimidos e descadastrados foram ignorados.{failed}',
      "Aberturas, cliques e bounces aparecem na página do broadcast conforme chegam.",
    ],
    button: "Abrir broadcast",
    extra: { failed: " {n} não puderam ser enviados." },
  },
  "broadcast.sending": {
    subject: '"{name}" está saindo ao longo de {days} dias',
    body: [
      "{first} de {count} e-mails saíram na primeira leva; o restante segue conforme a capacidade libera, o último por volta de {finishesAt}.",
      "Envios acima da capacidade diária da plataforma são distribuídos pelos dias seguintes; o e-mail transacional de {team} não fica retido atrás deles.",
    ],
    button: "Abrir broadcast",
    muted: [
      "Você recebe isto uma vez por broadcast que leva mais de um dia. O horário de término é uma estimativa e muda conforme outras equipes enviam.",
    ],
  },
  "broadcast.held_quota": {
    subject: '"{name}": {parked} de {count} destinatários aguardam a cota',
    body: [
      "{sent} e-mails saíram; {parked} estão retidos porque {team} atingiu a cota de {limit}.",
      "{release}",
    ],
    button: "Revisar plano",
    extra: {
      releaseDaily:
        "Eles saem após a virada às {resetsAt} UTC, ou minutos depois de um plano maior.",
      releaseMonthly:
        "Eles saem quando o período renovar em {date}, assim que o excedente for ativado em Cobrança, ou minutos depois de um plano maior.",
    },
  },
  "broadcast.held": {
    subject: '"{name}" está em espera',
    body: [
      'Os envios de {region} estão pausados em toda a plataforma enquanto as taxas de bounce e reclamação se estabilizam, então "{name}" aguarda em vez de sair; e-mails transacionais continuam saindo.',
      "Ele retoma sozinho — checamos a cada 15 minutos — e você recebe o relatório de envio de sempre ao terminar.",
    ],
    button: "Abrir broadcast",
  },
  "billing.payment_failed": {
    subject: "Pagamento recusado no plano {plan} de {team}",
    body: [
      "Não conseguimos cobrar o cartão cadastrado do plano {plan} de {team}.",
      "{retry} Por enquanto nada muda: {team} continua enviando {cap}. Se a fatura continuar em aberto, a Stripe cancela a assinatura e {team} volta ao Free ({freeCap} e-mails por dia).",
    ],
    button: "Pagar fatura",
    muted: ["Ou atualize o cartão em Cobrança: {billingUrl}"],
    extra: {
      retryOn: "A Stripe tenta de novo em {date}.",
      noRetry: "A Stripe não vai tentar de novo sozinha.",
    },
  },
  "billing.plan_activated": {
    subject: "{team} está no plano {plan}",
    body: [
      "Sua assinatura está ativa: {team} agora envia {cap}, e o que estava retido acima do limite antigo é liberado em minutos.",
      "Recibos e faturas vêm da Stripe; a assinatura é gerenciada em Cobrança.",
    ],
    button: "Abrir cobrança",
  },
  "billing.plan_changed": {
    subject: "{team} mudou de {old} para {new}",
    body: [
      "A partir de agora {team} envia {cap}. Num limite menor, os envios já aceitos não mudam; o que passar do novo limite, em planos diários espera o próximo dia UTC e, em planos mensais, cobra excedente (quando ativado) ou é recusado pela API até o período renovar.",
      "O rateio aparece na próxima fatura da Stripe.",
    ],
    button: "Abrir cobrança",
  },
  "billing.cancel_scheduled": {
    subject: "Seu plano {plan} termina em {date}",
    body: [
      "{team} continua no {plan} até {date}; depois volta ao Free ({freeCap} e-mails por dia).",
      "Mudou de ideia? Retome o plano em Cobrança antes disso e nada muda.",
    ],
    button: "Abrir cobrança",
  },
  "billing.cancel_reminder": {
    subject: "Lembrete: o plano {plan} de {team} termina em {date}",
    body: [
      "Em {date} {team} volta ao Free: {freeCap} e-mails por dia, e o que passar do limite espera o dia seguinte.",
      "Retome o plano em Cobrança para continuar enviando {cap}.",
    ],
    button: "Abrir cobrança",
  },
  "billing.downgraded": {
    subject: "{team} agora está no Free",
    body: [
      "O plano {plan} terminou em {date}. A partir de hoje {team} envia até {freeCap} e-mails por dia; o que passar espera o próximo dia UTC, e broadcasts acima do limite saem em partes.",
      "Domínios verificados, contatos e chaves de API continuam iguais. Escolha um plano de novo em Cobrança quando precisar de mais.",
    ],
    button: "Abrir cobrança",
  },
  "team.broadcasts_paused": {
    subject: "Broadcasts pausados para {team}",
    body: [
      "O operador da instância pausou os broadcasts de {team}: {reason}",
      "E-mails transacionais continuam saindo pela API e pelo SMTP. Broadcasts agendados aguardam, e novos não podem ser enviados, até o operador retomá-los. Responda a este e-mail se tiver dúvidas.",
    ],
    button: "Abrir broadcasts",
    extra: {
      complaints: "a taxa de reclamações passou de 0,1% nos últimos 7 dias.",
      report: "uma denúncia de abuso foi recebida.",
      manual: "veja a observação abaixo.",
      note: "Observação do operador: {note}",
    },
  },
  "team.suspended": {
    subject: "{team} foi suspensa",
    body: [
      "O operador da instância suspendeu {team}: {reason}",
      "Todo envio é recusado e os broadcasts ficam em espera. Chaves de API, domínios, contatos e histórico permanecem como estão, e uma equipe reativada volta a enviar em um minuto. Responda a este e-mail para resolver.",
    ],
    button: "Abrir painel",
    extra: {
      reputation:
        "suas taxas de bounce ou de reclamação ameaçam a reputação de envio que a plataforma compartilha.",
      non_payment: "uma fatura ficou sem pagamento.",
      manual: "veja a observação abaixo.",
      note: "Observação do operador: {note}",
    },
  },
  "team.reinstated": {
    subject: "{team} foi reativada",
    body: [
      "O operador da instância reativou {team}. Os envios voltam a sair, e os broadcasts em espera retomam sozinhos em até 15 minutos.",
    ],
    button: "Abrir painel",
  },
  "monitor.alert": {
    subject: "Monitor de conteúdo: {team} precisa de uma olhada",
    body: [
      "O risco do monitor de conteúdo para {team} chegou a {risk} (nível {tier}, {samples} amostras julgadas nos últimos 7 dias, {flagged} acima da linha de sinalização). O modelo lê uma amostra do e-mail aceito; nada foi pausado nem retido por conta dele.",
      "Abra a página de revisão para ver os veredictos amostrados, as verificações de conteúdo e o histórico da equipe, e decida. Este aviso se repete no máximo uma vez por dia por equipe enquanto o risco ficar acima da linha.",
    ],
    button: "Abrir revisão",
  },
  "monitor.broadcasts_paused": {
    subject: "O monitor de conteúdo pausou os broadcasts de {team}",
    body: [
      "{team} está no nível novo, seu risco no monitor chegou a {risk} e uma mensagem amostrada pontuou {score}. Pela política de pausa, seus broadcasts estão em espera; o e-mail transacional continua saindo.",
      "A equipe vê os broadcasts como pausados aguardando revisão. Abra a página de revisão para ler os veredictos e retomar, suspender ou limpar.",
    ],
    button: "Abrir revisão",
  },
  "monitor.degraded": {
    subject: "Monitor de conteúdo: {rate} das amostras ficaram sem julgamento na última hora",
    body: [
      "{unjudged} de {samples} amostras sorteadas na última hora voltaram sem julgamento ({provider} · {model}). O envio não é afetado: uma amostra sem julgamento não muda risco, não abre sinalização e não retém e-mail.",
      "As causas comuns são um provedor limitado ou inacessível, uma chave de API inválida ou revogada, ou respostas que o monitor não conseguiu ler. O cartão Saúde do console mostra a parcela sem julgamento.",
    ],
    button: "Abrir console",
    muted: [
      "Enviado ao operador da instância no máximo a cada seis horas enquanto a parcela ficar acima de 20% ou o provedor continuar recusando a chave de API.",
    ],
  },
  "content.access_notice": {
    subject: "Um operador leu conteúdo em {team}",
    body: [
      "Em {when}, um operador autorizado desta instância leu o assunto e o texto renderizado de {emails} em {team}, por um motivo de segurança registrado: {reason}.",
      "Endereços de destinatários, anexos, cabeçalhos e o HTML bruto não foram acessados, e o acesso se fechou depois de 30 minutos. Está registrado no log de auditoria desta equipe com a mesma data, e no log da instância desde que aconteceu.",
      "Este aviso é exigido de nós em até sete dias após um acesso desses e é enviado tenha ou não dado em algo. Responda a este e-mail se quiser saber mais.",
    ],
    button: "Abrir log de auditoria",
    extra: {
      one: "uma mensagem",
      many: "{n} mensagens",
      phishing_or_malware: "suspeita de phishing ou malware",
      complaint_spike: "um pico de reclamações de spam",
      provider_report: "uma denúncia de abuso de um provedor de caixa postal",
      legal_request: "uma solicitação judicial",
      owner_support_request: "um pedido de suporte desta equipe",
    },
  },
  "support.view_started": {
    subject: "Modo de suporte iniciado em {team}",
    body: [
      "{operator}, operador da instância, abriu o painel de {team} em um modo de suporte somente leitura {reason}. Ele termina às {until}, ou antes se você encerrá-lo.",
      "O conteúdo dos e-mails enviados, exportações e segredos não ficam visíveis nesse modo. Cada procedimento lido pelo operador é contado, e a sessão já aparece no log de auditoria da sua equipe em Configurações → Log de auditoria. Abra Acesso de suporte em Configurações para encerrá-la.",
    ],
    button: "Abrir acesso de suporte",
    extra: {
      support_ticket: "a seu pedido, chamado {reference}",
      billing_dispute: "por uma disputa de cobrança, referência {reference}",
      other: "por outro motivo{reference}",
      ref: " (referência {reference})",
    },
  },
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

export const ptBRPhrases = {
  capUpToDay: "até {n} e-mails por dia",
  capUpToMonth: "até {n} e-mails por mês",
  capNone: "sem limite de envio",
} as const satisfies Record<MailPhraseKey, string>;
