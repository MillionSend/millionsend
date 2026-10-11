import type { AccountMailEntry, AccountMailKind, MailPhraseKey } from "../account-mail.js";

export const ptBR = {
  welcome: {
    subject: "Bem-vindo ao MillionSend",
    body: [
      "Olá, {name}, sua conta está pronta.",
      "Primeiro adicione um domínio de envio e publique os registros DNS; os envios saem assim que ele for verificado.",
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
      "Ele pode fazer o mesmo que você, em seu nome, até você revogar o acesso.",
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
      "Membros enviam e leem os logs; administradores também gerenciam domínios, chaves e webhooks. Se foi engano, remova o membro em Configurações → Equipe.",
    ],
    button: "Abrir configurações da equipe",
    extra: { member: "membro", admin: "administrador", owner: "proprietário" },
  },
  "domain.verified": {
    subject: "Seu domínio está verificado",
    body: [
      "Os registros DNS de {domain} estão corretos e ele pode enviar de qualquer endereço — API, SMTP e transmissões.",
      "Continuamos verificando os registros e avisamos se algum sumir.",
    ],
    button: "Abrir domínio",
  },
  "domain.lost": {
    subject: "Um domínio perdeu a verificação",
    body: [
      "Um registro DNS obrigatório de {domain} (DKIM ou MAIL FROM) deixou de responder, então os envios são recusados até ele voltar — chamadas à API falham e transmissões agendadas param na hora do envio.",
      "Restaure o registro no seu DNS; a verificação volta sozinha na próxima checagem ou quando você clicar em Verificar.",
    ],
    button: "Abrir domínio",
  },
  "domain.lost.identity": {
    subject: "Um domínio perdeu a verificação",
    body: [
      "O SES desistiu de {domain}: a identidade sumiu ou os registros DKIM ficaram ausentes por mais de 72 horas. Os envios são recusados; adicione o domínio de novo para voltar a enviar.",
    ],
    button: "Abrir domínios",
  },
  "broadcast.sent": {
    subject: "Sua transmissão foi enviada para {count} destinatários",
    body: [
      '"{subject}" foi enviado para {count} contatos de {team}; endereços suprimidos e descadastrados foram ignorados.{failed}',
      "Aberturas, cliques e bounces aparecem na página da transmissão conforme chegam.",
    ],
    button: "Abrir transmissão",
    extra: { failed: " {n} não puderam ser enviados." },
  },
  "broadcast.sending": {
    subject: "Sua transmissão está saindo ao longo de {days} dias",
    body: [
      "{first} de {count} e-mails saíram na primeira leva; o restante segue conforme a capacidade libera, o último por volta de {finishesAt}.",
      "Envios acima da capacidade diária de envio são distribuídos pelos dias seguintes; o e-mail transacional de {team} não fica esperando atrás deles.",
    ],
    button: "Abrir transmissão",
    muted: [
      "Você recebe isto uma vez por transmissão que leva mais de um dia. O horário de término é uma estimativa e pode mudar.",
    ],
  },
  "broadcast.held_quota": {
    subject: "{parked} de {count} destinatários da transmissão aguardam a cota",
    body: [
      "{sent} e-mails saíram; {parked} estão em espera porque {team} atingiu a cota de {limit}.",
      "{release}",
    ],
    button: "Revisar plano",
    extra: {
      releaseDaily:
        "Eles saem depois que a cota renovar às {resetsAt} UTC, ou minutos depois de você mudar para um plano maior.",
      releaseMonthly:
        "Eles saem quando o período renovar em {date}, assim que o excedente for ativado em Cobrança, ou minutos depois de você mudar para um plano maior.",
    },
  },
  "broadcast.held": {
    subject: "Sua transmissão aguarda para sair",
    body: [
      '"{name}" aguarda para sair. O envio está pausado por enquanto e retoma automaticamente, então você não precisa fazer nada; e-mails transacionais continuam saindo.',
      "Você recebe o relatório de envio de sempre ao terminar.",
    ],
    button: "Abrir transmissão",
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
        "Ao atingir a cota, novos envios pela API são recusados e as transmissões ficam em espera até o período renovar. Ative o excedente em Cobrança para continuar enviando além dela, ou mude para um plano maior.",
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
        "Novos envios pela API são recusados até o período renovar em {renewsAt} ou o excedente ser ativado em Cobrança; as transmissões ficam em espera até lá. Um plano maior aumenta a cota na hora e libera o que estava em espera em minutos.",
    },
  },
  "deliverability.warning": {
    subject: "Sua {metric} está em risco",
    body: [
      "A {metric} de {team} nos últimos {days} dias está em {rate}, acima do limite de risco de {limit}. Os envios continuam, mas as transmissões ficam mais lentas enquanto ela estiver acima do limite.",
      "{advice}",
    ],
    button: "Abrir métricas",
    muted: [
      "Você recebe isto uma vez por episódio; ele se encerra quando a taxa volta a ficar abaixo do limite.",
    ],
    extra: {
      bounce: "taxa de bounce permanente",
      complaint: "taxa de reclamação",
      bounceAdvice:
        "Bounces permanentes vêm de endereços que não existem. Remova endereços antigos ou não verificados das suas listas; todo endereço com bounce já está na sua lista de supressão.",
      complaintAdvice:
        "Reclamações vêm de destinatários que não esperavam o e-mail. Envie só para quem se inscreveu, mantenha o link de descadastro visível e pause listas que não recebem nada seu há meses.",
    },
  },
  "deliverability.paused": {
    subject: "Envios pausados ({metric})",
    body: [
      "A {metric} de {team} nos últimos {days} dias chegou a {rate}, no limite de pausa de {limit} ou acima dele. Novos envios são recusados até ela baixar.",
      "A pausa termina sozinha quando a taxa na janela volta a ficar abaixo do limite. Limpe a lista de destinatários antes, ou os próximos envios vão acioná-la de novo.",
    ],
    button: "Abrir métricas",
    muted: ["Você recebe isto uma vez por episódio."],
    extra: { bounce: "taxa de bounce permanente", complaint: "taxa de reclamação" },
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
      "{retry} Por enquanto {team} mantém o plano {plan} ({cap}). Se a fatura continuar em aberto, o Stripe cancela a assinatura e {team} volta ao Free ({freeCap} e-mails por dia).",
    ],
    button: "Pagar fatura",
    muted: ["Ou atualize o cartão em Cobrança: {billingUrl}"],
    extra: {
      retryOn: "O Stripe tenta de novo em {date}.",
      noRetry: "O Stripe não vai tentar de novo sozinho.",
    },
  },
  "billing.plan_activated": {
    subject: "Sua equipe está no plano {plan}",
    body: [
      "Sua assinatura está ativa: o {plan} permite {cap}, e o que estava em espera por causa do limite antigo não depende mais dele.",
      "Recibos e faturas vêm do Stripe; a assinatura é gerenciada em Cobrança.",
    ],
    button: "Abrir cobrança",
  },
  "billing.plan_changed": {
    subject: "Sua equipe mudou de {old} para {new}",
    body: [
      "{team} agora está no {new}, que permite {cap}. Com um limite menor, os envios já aceitos não mudam; o que passar do novo limite espera o próximo dia UTC nos planos diários e, nos planos mensais, é cobrado como excedente (quando ativado) ou recusado pela API até o período renovar.",
      "O rateio aparece na próxima fatura do Stripe.",
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
      "Retome o plano em Cobrança para continuar no {plan} ({cap}).",
    ],
    button: "Abrir cobrança",
  },
  "billing.downgraded": {
    subject: "Sua equipe agora está no Free",
    body: [
      "O plano {plan} terminou em {date}. A partir de hoje {team} está no Free: até {freeCap} e-mails por dia, o que passar espera o próximo dia UTC, e transmissões acima do limite saem em partes.",
      "Domínios verificados, contatos e chaves de API continuam iguais. Escolha um plano de novo em Cobrança quando precisar de mais.",
    ],
    button: "Abrir cobrança",
  },
  "team.broadcasts_paused": {
    subject: "Transmissões pausadas para sua equipe",
    body: [
      "O operador da instância pausou as transmissões de {team}: {reason}",
      "E-mails transacionais continuam saindo pela API e pelo SMTP. Transmissões agendadas aguardam, e novas não podem ser enviadas, até o operador retomá-las. Responda a este e-mail se tiver dúvidas.",
    ],
    button: "Abrir transmissões",
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
      "Todo envio é recusado e as transmissões ficam em espera. Chaves de API, domínios, contatos e histórico permanecem como estão, e uma equipe reativada volta a enviar em um minuto. Responda a este e-mail para resolver.",
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
      "O operador da instância reativou {team}. Os envios voltam a sair, e as transmissões em espera são retomadas automaticamente em até 15 minutos.",
    ],
    button: "Abrir painel",
  },
  "monitor.alert": {
    subject: "Monitor de conteúdo: uma equipe precisa de uma olhada",
    body: [
      "O risco do monitor de conteúdo para {team} chegou a {risk} (nível {tier}, {samples} amostras avaliadas nos últimos 7 dias, {flagged} acima do limite de sinalização). O modelo lê uma amostra dos e-mails aceitos; este alerta, por si só, não pausa nem segura nada.",
      "Abra a página de revisão para ver as avaliações das amostras, as verificações de conteúdo e o histórico da equipe, e decida. Este aviso se repete no máximo uma vez por dia por equipe enquanto o risco ficar acima do limite.",
    ],
    button: "Abrir revisão",
    extra: {
      new: "novo",
      probation: "em observação",
      established: "estabelecido",
      trusted: "confiável",
      exempt: "isento",
    },
  },
  "monitor.broadcasts_paused": {
    subject: "O monitor de conteúdo pausou as transmissões de uma equipe",
    body: [
      "{team} é uma equipe nova, o risco dela no monitor chegou a {risk} e uma mensagem amostrada teve pontuação {score}. Pela política de pausa, as transmissões dela estão em espera; o e-mail transacional continua saindo.",
      "A equipe vê as transmissões como pausadas aguardando revisão. Abra a página de revisão para ler as avaliações e retomar, suspender ou encerrar a sinalização.",
    ],
    button: "Abrir revisão",
  },
  "monitor.team_held": {
    subject: "O monitor de conteúdo pausou uma equipe para revisão",
    body: [
      "{team} é uma equipe nova e uma mensagem amostrada teve pontuação {score} ({verdict}). {rule} Pela política de pausa para revisão, nada da equipe sai: os e-mails que ela envia pela API e pelo SMTP são aceitos e ficam em espera, os e-mails na fila e as transmissões aguardam, novas transmissões são recusadas e o tenant da equipe no SES fica desativado onde os tenants estão ligados. A própria mensagem amostrada já tinha saído quando foi avaliada.",
      "O proprietário não recebe e-mail: o painel mostra o envio pausado aguardando revisão, e a API e o SMTP respondem como para qualquer envio aceito. Abra a página de revisão para liberar a equipe, o que envia os e-mails em espera, ou para suspendê-la por phishing.",
    ],
    button: "Abrir revisão",
    extra: {
      score: "Esta avaliação, sozinha, pausou a equipe: a pontuação de revisão é {line}.",
      repeat:
        "Esta avaliação pausou a equipe por ser a {n}ª do tipo phishing com pontuação {line} ou mais em 7 dias.",
    },
  },
  "monitor.team_linked": {
    subject: "Uma equipe nova coincide com uma equipe suspensa por phishing",
    body: [
      "{team} coincide com {linked}, uma equipe que você suspendeu por phishing, em: {matches}. {held}",
      "Abra a página de revisão para ver o que coincidiu e depois liberar a equipe ou suspendê-la por phishing.",
    ],
    button: "Abrir revisão",
    extra: {
      held: "Ela fica pausada para revisão antes de enviar qualquer coisa: os e-mails ficam em espera até você decidir, e o proprietário vê o envio como pausado aguardando revisão, sem receber e-mail sobre isso.",
      notHeld: "A pausa automática para revisão está desligada, então a equipe não foi pausada.",
      display_name: "nome do remetente",
      subject: "assunto",
      sending_domain: "nome do domínio",
      link_domain: "domínio dos links",
      phone: "telefone",
      text_hash: "texto do e-mail",
      card: "cartão",
      ip: "endereço IP",
      address: "endereço de e-mail",
    },
  },
  "monitor.degraded": {
    subject: "Monitor de conteúdo: {rate} das amostras ficaram sem avaliação na última hora",
    body: [
      "{unjudged} de {samples} amostras sorteadas na última hora voltaram sem avaliação ({provider} · {model}). O envio não é afetado: uma amostra sem avaliação não muda o risco, não abre sinalização e não segura nenhum e-mail.",
      "As causas comuns são um provedor limitando requisições ou fora do ar, uma chave de API inválida ou revogada, ou respostas que o monitor não conseguiu ler. O cartão Saúde do console mostra o percentual sem avaliação.",
    ],
    button: "Abrir console",
    muted: [
      "Enviado ao operador da instância no máximo a cada seis horas enquanto o percentual ficar acima de 20% ou o provedor continuar recusando a chave de API.",
    ],
  },
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

export const ptBRPhrases = {
  capUpToDay: "até {n} e-mails por dia",
  capUpToMonth: "até {n} e-mails por mês",
  capNone: "sem limite de envio",
} as const satisfies Record<MailPhraseKey, string>;
