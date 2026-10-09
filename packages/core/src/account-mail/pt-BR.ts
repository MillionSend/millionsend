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
    subject: "Um app foi conectado à sua conta do MillionSend",
    body: [
      "Você permitiu que {app} atue em {team} pelo servidor MCP do MillionSend com estas permissões: {scopes}.",
      "Ele pode fazer ali o que você pode, em seu nome, até você revogar.",
    ],
    button: "Revisar apps conectados",
    muted: ["Não autorizou isso? Revogue agora."],
    extra: { allTeams: "todas as suas equipes" },
  },
  "api_key.created": {
    subject: "Uma nova chave de API foi criada",
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
    subject: "Um segredo de assinatura de webhook foi rotacionado",
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
    subject: "Um novo membro entrou na sua equipe",
    body: [
      "{name} ({email}) aceitou o convite e agora é {role} de {team}.",
      "Membros enviam e leem os logs; administradores também gerenciam domínios, chaves e webhooks. Remova em Configurações → Equipe se estiver errado.",
    ],
    button: "Abrir configurações da equipe",
    extra: { member: "membro", admin: "administrador", owner: "proprietário" },
  },
  "domain.verified": {
    subject: "Seu domínio está verificado",
    body: [
      "Os registros DNS de {domain} estão corretos e ele pode enviar de qualquer endereço — API, SMTP e broadcasts.",
      "Continuamos verificando os registros e avisamos se algum sumir.",
    ],
    button: "Abrir domínio",
  },
  "domain.lost": {
    subject: "Um domínio perdeu a verificação",
    body: [
      "Um registro DNS obrigatório de {domain} (DKIM ou MAIL FROM) deixou de responder, então os envios são recusados até ele voltar — chamadas à API falham e broadcasts agendados param na hora do envio.",
      "Restaure o registro no seu DNS; a verificação volta sozinha na próxima checagem ou quando você clicar em Verificar.",
    ],
    button: "Abrir domínio",
  },
  "domain.lost.identity": {
    subject: "Um domínio perdeu a verificação",
    body: [
      "O SES desistiu de {domain}: a identidade sumiu ou os registros DKIM ficaram ausentes além da janela de 72 horas. Os envios são recusados; adicione o domínio de novo para voltar a enviar.",
    ],
    button: "Abrir domínios",
  },
  "broadcast.sent": {
    subject: "Seu broadcast foi enviado para {count} destinatários",
    body: [
      '"{subject}" foi entregue a {count} contatos de {team}; endereços suprimidos e descadastrados foram ignorados.{failed}',
      "Aberturas, cliques e bounces aparecem na página do broadcast conforme chegam.",
    ],
    button: "Abrir broadcast",
    extra: { failed: " {n} não puderam ser enviados." },
  },
  "broadcast.sending": {
    subject: "Seu broadcast está saindo ao longo de {days} dias",
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
    subject: "{parked} de {count} destinatários do broadcast aguardam a cota",
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
    subject: "Seu broadcast aguarda para sair",
    body: [
      'Os envios de {region} estão pausados em toda a plataforma enquanto as taxas de bounce e reclamação se estabilizam, então "{name}" aguarda em vez de sair; e-mails transacionais continuam saindo.',
      "Ele retoma sozinho — checamos a cada 15 minutos — e você recebe o relatório de envio de sempre ao terminar.",
    ],
    button: "Abrir broadcast",
  },
  "quota.warning": {
    subject: "80% da cota de envio de hoje foi usada",
    body: [
      "{team} já usou {used} dos seus {limit} e-mails de hoje.",
      "Os envios continuam saindo até {tolerance} acima da cota; depois disso, entram na fila até a cota renovar às {resetsAt}. Um plano maior aumenta a cota diária na hora.",
    ],
    button: "Revisar plano",
    muted: ["Você recebe isto uma vez por dia quando uma equipe sua se aproxima da cota."],
  },
  "quota.reached": {
    subject: "Cota de envio de hoje atingida",
    body: [
      "{team} usou os seus {limit} e-mails de hoje ({used} aceitos).",
      "Mais {headroom} ainda saem hoje (os envios passam até {tolerance} acima da cota); o que passar disso entra na fila e sai depois que a cota renovar às {resetsAt}. Um plano maior aumenta a cota diária na hora e libera a fila em minutos.",
    ],
    button: "Revisar plano",
    muted: ["Você recebe isto uma vez por dia quando uma equipe sua atinge a cota."],
  },
  "quota.paused": {
    subject: "Envios pausados até a cota renovar",
    body: [
      "{team} usou {used} e-mails hoje, {tolerance} acima da cota de {limit}, então os novos envios entram na fila em vez de sair.",
      "O que está na fila sai depois que a cota renovar às {resetsAt}. Um plano maior aumenta a cota diária na hora e libera a fila em minutos.",
    ],
    button: "Revisar plano",
    muted: ["Você recebe isto uma vez por dia quando uma equipe sua passa do teto da cota."],
  },
  "quota.monthly_warning": {
    subject: "80% da cota de envio deste período foi usada",
    body: [
      "{team} usou {used} dos {limit} e-mails incluídos no plano neste período de cobrança, que renova em {renewsAt}.",
      "{advice}",
    ],
    button: "Revisar plano",
    muted: [
      "Você recebe isto uma vez por período de cobrança quando uma equipe sua se aproxima da cota.",
    ],
    extra: {
      overage:
        "Os envios acima da cota são cobrados pela tarifa de excedente do seu plano e aparecem na próxima fatura. Um plano maior inclui mais e-mails a uma tarifa menor.",
      noOverage:
        "Na cota, novos envios pela API são recusados e os broadcasts ficam retidos até o período renovar. Ative o excedente em Cobrança para continuar enviando além dela, ou mude para um plano maior.",
    },
  },
  "quota.monthly_reached": {
    subject: "Cota de envio deste período atingida",
    body: [
      "{team} usou os {limit} e-mails incluídos no plano neste período de cobrança ({used} aceitos).",
      "{advice}",
    ],
    button: "Revisar plano",
    muted: [
      "Você recebe isto uma vez por período de cobrança quando uma equipe sua atinge a cota.",
    ],
    extra: {
      overage:
        "Os envios acima da cota agora são cobrados pela tarifa de excedente do seu plano e aparecem na próxima fatura. Eles param em {hardCap} vezes o volume incluído ({stopAt}) até o período renovar em {renewsAt}; um plano maior inclui mais e-mails a uma tarifa menor.",
      noOverage:
        "Novos envios pela API são recusados até o período renovar em {renewsAt} ou o excedente ser ativado em Cobrança; os broadcasts ficam retidos até lá. Um plano maior aumenta a cota na hora e libera o que estava retido em minutos.",
    },
  },
  "deliverability.warning": {
    subject: "Sua {metric} está em risco",
    body: [
      "A {metric} de {team} nos últimos {days} dias está em {rate}, acima da linha de risco de {limit}. Os envios continuam, mas os broadcasts ficam mais lentos enquanto ela estiver aí.",
      "{advice}",
    ],
    button: "Abrir métricas",
    muted: [
      "Você recebe isto uma vez por episódio; ele se encerra quando a taxa volta para baixo da linha.",
    ],
    extra: {
      bounce: "taxa de hard bounce",
      complaint: "taxa de reclamação",
      bounceAdvice:
        "Hard bounces vêm de endereços que não existem. Remova endereços antigos ou não verificados das suas listas; todo endereço com bounce já está na sua lista de supressão.",
      complaintAdvice:
        "Reclamações vêm de destinatários que não esperavam o e-mail. Envie só para quem se inscreveu, mantenha o link de descadastro visível e pause listas que não recebem nada seu há meses.",
    },
  },
  "deliverability.paused": {
    subject: "Envios pausados ({metric})",
    body: [
      "A {metric} de {team} nos últimos {days} dias chegou a {rate}, na linha de pausa de {limit} ou acima dela. Novos envios são recusados até ela se recuperar.",
      "A pausa termina sozinha quando a taxa na janela volta para baixo da linha. Limpe a lista de destinatários antes, ou os próximos envios vão acioná-la de novo.",
    ],
    button: "Abrir métricas",
    muted: ["Você recebe isto uma vez por episódio."],
    extra: { bounce: "taxa de hard bounce", complaint: "taxa de reclamação" },
  },
  "webhook.failing": {
    subject: "As entregas de webhook estão falhando",
    body: [
      "As últimas {streak} entregas para {url} falharam em todas as tentativas, então {team} está perdendo eventos.",
      "Confira se o receptor está no ar, responde 2xx rápido e verifica com o segredo de assinatura atual. As tentativas continuam sozinhas; depois de {disableAfter} entregas seguidas com falha, o endpoint é desativado.",
    ],
    button: "Abrir endpoint",
    muted: [
      "Você recebe isto uma vez por episódio; ele se encerra quando uma entrega volta a dar certo.",
    ],
  },
  "webhook.auto_disabled": {
    subject: "Um endpoint de webhook foi desativado após falhas seguidas",
    body: [
      "{url} foi desativado automaticamente depois que {after} entregas seguidas falharam em todas as tentativas. Os eventos não entram mais na fila dele.",
      "Corrija o receptor e reative o endpoint na página dele. Eventos que acontecem enquanto ele está desativado não são reenviados.",
    ],
    button: "Abrir endpoint",
    muted: [
      "Você recebe isto sempre que um endpoint de uma equipe sua é desativado automaticamente.",
    ],
  },
  "webhook.backlog": {
    subject: "As entregas de webhook estão acumulando",
    body: [
      "{queued} entregas para {url} estão esperando; a mais antiga está pendente há {age}. O receptor está lento, limitando requisições ou falhando, então os eventos chegam atrasados.",
      "Entregas com mais de 24 horas são descartadas. Acelere o receptor ou inscreva o endpoint só nos eventos de que ele precisa.",
    ],
    button: "Abrir endpoint",
    muted: ["Você recebe isto no máximo uma vez por dia por endpoint."],
    extra: { moreThan: "Mais de {n}" },
  },
  "billing.payment_failed": {
    subject: "Pagamento recusado no seu plano {plan}",
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
    subject: "Sua equipe está no plano {plan}",
    body: [
      "Sua assinatura está ativa: {team} agora envia {cap}, e o que estava retido acima do limite antigo é liberado em minutos.",
      "Recibos e faturas vêm da Stripe; a assinatura é gerenciada em Cobrança.",
    ],
    button: "Abrir cobrança",
  },
  "billing.plan_changed": {
    subject: "Sua equipe mudou de {old} para {new}",
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
    subject: "Lembrete: seu plano {plan} termina em {date}",
    body: [
      "Em {date} {team} volta ao Free: {freeCap} e-mails por dia, e o que passar do limite espera o dia seguinte.",
      "Retome o plano em Cobrança para continuar enviando {cap}.",
    ],
    button: "Abrir cobrança",
  },
  "billing.downgraded": {
    subject: "Sua equipe agora está no Free",
    body: [
      "O plano {plan} terminou em {date}. A partir de hoje {team} envia até {freeCap} e-mails por dia; o que passar espera o próximo dia UTC, e broadcasts acima do limite saem em partes.",
      "Domínios verificados, contatos e chaves de API continuam iguais. Escolha um plano de novo em Cobrança quando precisar de mais.",
    ],
    button: "Abrir cobrança",
  },
  "team.broadcasts_paused": {
    subject: "Broadcasts pausados para sua equipe",
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
    subject: "Sua equipe foi suspensa",
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
    subject: "Sua equipe foi reativada",
    body: [
      "O operador da instância reativou {team}. Os envios voltam a sair, e os broadcasts em espera retomam sozinhos em até 15 minutos.",
    ],
    button: "Abrir painel",
  },
  "monitor.alert": {
    subject: "Monitor de conteúdo: uma equipe precisa de uma olhada",
    body: [
      "O risco do monitor de conteúdo para {team} chegou a {risk} (nível {tier}, {samples} amostras julgadas nos últimos 7 dias, {flagged} acima da linha de sinalização). O modelo lê uma amostra do e-mail aceito; nada foi pausado nem retido por conta dele.",
      "Abra a página de revisão para ver os veredictos amostrados, as verificações de conteúdo e o histórico da equipe, e decida. Este aviso se repete no máximo uma vez por dia por equipe enquanto o risco ficar acima da linha.",
    ],
    button: "Abrir revisão",
  },
  "monitor.broadcasts_paused": {
    subject: "O monitor de conteúdo pausou os broadcasts de uma equipe",
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
    subject: "Um operador leu conteúdo na sua equipe",
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
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

export const ptBRPhrases = {
  capUpToDay: "até {n} e-mails por dia",
  capUpToMonth: "até {n} e-mails por mês",
  capNone: "sem limite de envio",
} as const satisfies Record<MailPhraseKey, string>;
