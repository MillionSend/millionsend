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
      '"{subject}" foi entregue a {count} contatos de {team}; endereços suprimidos e descadastrados foram ignorados.',
      "Aberturas, cliques e bounces aparecem na página do broadcast conforme chegam.",
    ],
    button: "Abrir broadcast",
  },
  "broadcast.held_quota": {
    subject: '"{name}": {parked} de {count} destinatários aguardam a cota',
    body: [
      "{sent} e-mails saíram; {parked} estão retidos porque {team} atingiu a cota diária de {limit}.",
      "Eles saem após a virada às {resetsAt} UTC, ou minutos depois de um plano maior.",
    ],
    button: "Revisar plano",
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
      "A partir de agora {team} envia {cap}. Num limite menor, os envios já aceitos não mudam; o que passar do novo limite espera o próximo dia UTC.",
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
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

export const ptBRPhrases = {
  capUpTo: "até {n} e-mails por dia",
  capNone: "sem limite diário",
} as const satisfies Record<MailPhraseKey, string>;
