import type { AccountMailEntry, AccountMailKind, MailPhraseKey } from "../account-mail.js";

export const ptBR = {
  welcome: {
    subject: "Bem-vindo ao MillionSend",
    body: [
      "Olá, {name}, sua conta está pronta.",
      "Primeiro adicione um domínio de envio e publique os registros DNS. Os envios saem assim que ele for verificado, e um domínio registrado há pouco tempo começa com um limite diário que cresce nas primeiras semanas.",
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
      "Ele pode fazer o mesmo que você, em seu nome, {until}.",
    ],
    button: "Revisar apps conectados",
    muted: ["Não autorizou isso? Revogue agora."],
    extra: {
      allTeams: "todas as suas equipes",
      untilDisconnected: "até você desconectar",
      untilDate: "até {date}",
    },
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
      "Os registros DNS de {domain} estão corretos. Ele pode enviar de qualquer endereço do domínio, pela API, pelo SMTP e por transmissões.",
      "{limit}",
      "{moving}",
      "Continuamos verificando os registros e avisamos se algum sumir.",
    ],
    button: "Abrir domínio",
    extra: {
      limit:
        "Como ele foi registrado há pouco tempo, começa com um limite diário: até {perDay} e-mails hoje, um pouco mais a cada dia, e sem limite a partir de {date}. O que passar do limite do dia fica esperando e sai sozinho no dia seguinte.",
      limitUnknownAge:
        "Ele começa com um limite diário de até {perDay} e-mails por enquanto, que vai subindo conforme ele cria um histórico de envios. O que passar do limite do dia fica esperando e sai sozinho no dia seguinte.",
      moving:
        "Vai trazer para este domínio e-mails que você já envia por outro serviço? Responda a este e-mail antes de mudar e a gente dá uma olhada.",
    },
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
  "domain.waiting": {
    subject: "Seu domínio novo atingiu o limite de hoje",
    heading: "{waiting}",
    body: [
      "{reached} Está tudo funcionando. O restante fica esperando e sai sozinho depois das 00:00 UTC, então não precisa reenviar.",
      "{schedule}",
      "Domínios novos começam com pouco volume porque os provedores de e-mail desconfiam de mensagens vindas deles. Um plano maior não muda isso. Vai trazer para cá e-mails que você já envia por outro serviço? Responda a este e-mail e a gente dá uma olhada.",
    ],
    button: "Ver e-mails esperando",
    muted: [
      "Você recebe isto no máximo uma vez por dia por domínio enquanto houver e-mails esperando.",
    ],
    extra: {
      "waiting.one": "1 e-mail esperando",
      "waiting.other": "{n} e-mails esperando",
      "reached.domain": "{domain} atingiu o limite diário de {cap} e-mails.",
      "reached.pool":
        "{domain} e seus outros domínios novos já enviaram os {cap} e-mails que dividem por dia.",
      schedule:
        "O limite cresce a cada dia, e o domínio passa a enviar sem limite a partir de {date}.",
      scheduleUnknownAge: "O limite cresce conforme o domínio cria um histórico de envios.",
    },
  },
  "domain.limit_lifted": {
    subject: "O limite diário do seu domínio foi retirado",
    body: [
      "{domain} agora envia sem o limite diário de domínios novos. Os e-mails que estavam esperando já estão saindo.",
    ],
    button: "Abrir domínio",
  },
  "domain.limit_kept": {
    subject: "Analisamos seu pedido de limite diário",
    body: [
      "{domain} continua com o limite diário por enquanto.{grows} Se tiver alguma dúvida, é só responder a este e-mail.",
    ],
    button: "Abrir domínio",
    extra: { grows: " Ele cresce sozinho, e a partir de {date} não tem mais limite." },
  },
  "domain.limit_requested": {
    subject: "Uma equipe pediu um limite diário maior",
    body: [
      "{team} pediu para tirar o limite de domínio novo de {domain}.",
      "Pedido: cerca de {perDay} e-mails por dia. Envia: {sends}. Hoje: {source}.",
      "{noteLine}",
      "Aprove com Confiar no domínio, ou recuse, na página de revisão da equipe. A equipe recebe a resposta por e-mail nos dois casos.",
    ],
    button: "Abrir revisão",
    muted: ["Enviado ao operador da instância uma vez por pedido."],
    extra: {
      "sends.account": "e-mails de cadastro e de conta",
      "sends.notifications": "recibos e notificações",
      "sends.marketing": "newsletters e marketing",
      "sends.mix": "um pouco de cada",
      "source.new": "ainda não envia, é um produto novo",
      "source.other_provider": "envia por outro provedor de e-mail",
      "source.own_servers": "envia pelos próprios servidores de e-mail",
      note: "Observação: {note}",
    },
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
      "{progress}",
      "O e-mail transacional de {team} não fica esperando atrás desta transmissão.",
    ],
    button: "Abrir transmissão",
    muted: [
      "Você recebe isto uma vez por transmissão que leva mais de um dia. O horário de término é uma estimativa e pode mudar.",
    ],
    extra: {
      wave: "{first} de {count} e-mails saíram na primeira leva. O restante segue conforme a capacidade libera, e o último sai por volta de {finishesAt}.",
      warmup:
        "{domain} está em aquecimento, então envia um pouco mais a cada dia, primeiro para os contatos mais ativos. O último e-mail sai por volta de {finishesAt}.",
    },
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
      releasePaused:
        "Há um pagamento pendente, então o excedente está pausado. Eles saem poucos minutos depois de você pagar a fatura em aberto em Cobrança, ou quando o período renovar em {date}.",
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
      "{shared}",
      "Os envios continuam saindo até {tolerance} acima da cota; depois disso, entram na fila até a cota renovar às {resetsAt}. Um plano maior aumenta a cota diária na hora.",
    ],
    button: "Revisar plano",
    muted: ["Você recebe isto uma vez por dia quando uma equipe sua se aproxima da cota."],
    extra: {
      shared:
        "No plano Free, todas as equipes Free criadas pela mesma pessoa dividem este limite diário, então a contagem acima inclui todas elas.",
    },
  },
  "quota.reached": {
    subject: "Cota de envio de hoje atingida",
    body: [
      "{team} usou os seus {limit} e-mails de hoje ({used} aceitos).",
      "{shared}",
      "Mais {headroom} ainda saem hoje (os envios passam até {tolerance} acima da cota); o que passar disso entra na fila e sai depois que a cota renovar às {resetsAt}. Um plano maior aumenta a cota diária na hora e libera a fila em minutos.",
    ],
    button: "Revisar plano",
    muted: ["Você recebe isto uma vez por dia quando uma equipe sua atinge a cota."],
    extra: {
      shared:
        "No plano Free, todas as equipes Free criadas pela mesma pessoa dividem este limite diário, então a contagem acima inclui todas elas.",
    },
  },
  "quota.paused": {
    subject: "Envios pausados até a cota renovar",
    body: [
      "{team} usou {used} e-mails hoje, {tolerance} acima da cota de {limit}, então os novos envios entram na fila em vez de sair.",
      "{shared}",
      "O que está na fila sai depois que a cota renovar às {resetsAt}. Um plano maior aumenta a cota diária na hora e libera a fila em minutos.",
    ],
    button: "Revisar plano",
    muted: ["Você recebe isto uma vez por dia quando uma equipe sua passa do teto da cota."],
    extra: {
      shared:
        "No plano Free, todas as equipes Free criadas pela mesma pessoa dividem este limite diário, então a contagem acima inclui todas elas.",
    },
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
      overagePaused:
        "Há um pagamento pendente, então o excedente está pausado: ao atingir a cota, novos envios pela API são recusados e as transmissões ficam em espera até a fatura em aberto ser paga. Atualize o cartão em Cobrança para liberar o excedente.",
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
      overagePaused:
        "Há um pagamento pendente, então o excedente está pausado: novos envios pela API são recusados e as transmissões ficam em espera até a fatura em aberto ser paga. Atualize o cartão em Cobrança; o que estava em espera sai poucos minutos depois do pagamento.",
    },
  },
  "deliverability.warning": {
    subject: "Sua {metric} está em risco",
    body: [
      "A {metric} de {team} {window} está em {rate}, acima do limite de risco de {limit}. Os envios continuam, mas as transmissões ficam mais lentas enquanto ela estiver acima do limite.",
      "{shared}",
      "{advice}",
    ],
    button: "Abrir métricas",
    muted: [
      "Você recebe isto uma vez por episódio; ele se encerra quando a taxa volta a ficar abaixo do limite.",
    ],
    extra: {
      bounce: "taxa de bounce permanente",
      complaint: "taxa de reclamação",
      bounceWindow: "nos últimos {days} dias",
      complaintWindow: "nos e-mails enviados nos últimos {days} dias",
      bounceAdvice:
        "Bounces permanentes vêm de endereços que não existem. Remova endereços antigos ou não verificados das suas listas; todo endereço com bounce já está na sua lista de supressão.",
      complaintAdvice:
        "Reclamações vêm de destinatários que não esperavam o e-mail. Envie só para quem se inscreveu, mantenha o link de descadastro visível e pause listas que não recebem nada seu há meses.",
      shared:
        "No plano Free, todas as equipes Free criadas pela mesma pessoa dividem um só histórico de bounces e reclamações, inclusive as excluídas: esta taxa conta todas elas, e as transmissões de cada uma ficam mais lentas.",
    },
  },
  "deliverability.paused": {
    subject: "Envios pausados ({metric})",
    body: [
      "A {metric} de {team} {window} chegou a {rate}, no limite de pausa de {limit} ou acima dele. Novos envios são recusados até ela baixar.",
      "{shared}",
      "A pausa termina sozinha quando a taxa na janela volta a ficar abaixo do limite. Limpe a lista de destinatários antes, ou os próximos envios vão acioná-la de novo.",
    ],
    button: "Abrir métricas",
    muted: ["Você recebe isto uma vez por episódio."],
    extra: {
      bounce: "taxa de bounce permanente",
      complaint: "taxa de reclamação",
      bounceWindow: "nos últimos {days} dias",
      complaintWindow: "nos e-mails enviados nos últimos {days} dias",
      shared:
        "No plano Free, todas as equipes Free criadas pela mesma pessoa dividem um só histórico de bounces e reclamações, inclusive as excluídas: esta taxa conta todas elas, e a pausa vale para cada uma.",
    },
  },
  "warmup.paused": {
    subject: "Aquecimento pausado no seu domínio",
    body: [
      "{domain} parou de enviar transmissões depois da última verificação. {signals}",
      "{waiting}",
      "Veja para quem você está enviando e retome na aba Aquecimento do domínio.",
    ],
    button: "Abrir aquecimento",
    extra: {
      delays: "O Gmail atrasou {pct} dos e-mails do dia.",
      opens: "As aberturas no Gmail ficaram em {pct} das outras caixas.",
      hardBounces: "{pct} dos endereços deram bounce.",
      mailboxFull: "{pct} das caixas estavam cheias ou inativas.",
      complaints: "{pct} das pessoas marcaram como spam.",
      "waiting.one": "1 e-mail está esperando até você retomar.",
      "waiting.other": "{n} e-mails estão esperando até você retomar.",
    },
  },
  "warmup.done": {
    subject: "Seu domínio terminou o aquecimento",
    body: [
      "{domain} enviou {volume} e-mails em um dia com entrega saudável. O aquecimento acabou e as transmissões dele agora saem na velocidade normal.",
    ],
    button: "Abrir domínio",
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
  "inbox.attention": {
    subject: "Suas caixas de entrada precisam de atenção",
    body: ["Até agora hoje: {counts}.", "Revise no painel."],
    button: "Revisar caixas",
    extra: {
      "quarantined.one": "{n} e-mail em quarentena",
      "quarantined.other": "{n} e-mails em quarentena",
      "drafts.one": "{n} rascunho aguardando aprovação",
      "drafts.other": "{n} rascunhos aguardando aprovação",
      "refused.one": "{n} envio barrado pelas regras das suas caixas",
      "refused.other": "{n} envios barrados pelas regras das suas caixas",
    },
  },
  "billing.payment_failed": {
    subject: "Pagamento recusado no seu plano {plan}",
    body: [
      "Não conseguimos cobrar o cartão cadastrado do plano {plan} de {team}.",
      "{retry} Por enquanto {team} mantém o plano {plan} ({cap}){overage}. Se a fatura continuar em aberto, o Stripe cancela a assinatura e {team} volta ao Free ({freeCap} e-mails por dia).",
    ],
    button: "Pagar fatura",
    muted: ["Ou atualize o cartão em Cobrança: {billingUrl}"],
    extra: {
      retryOn: "O Stripe tenta de novo em {date}.",
      noRetry: "O Stripe não vai tentar de novo sozinho.",
      overagePaused:
        ", mas o excedente fica pausado até a fatura ser paga, então os envios param no volume incluído",
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
      "Subir de plano é cobrado na hora, proporcional ao resto do período e junto com o excedente usado até agora; descer vale na renovação, sem reembolso.",
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
      complaints: "a taxa de reclamações dos e-mails enviados nos últimos 7 dias passou de 0,1%.",
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
      "{team} é uma equipe nova: uma mensagem amostrada teve pontuação {score} e o risco dela no monitor está em {risk}. Pela política de pausa, as transmissões dela estão em espera; o e-mail transacional continua saindo.",
      "A equipe vê as transmissões como pausadas aguardando revisão. Abra a página de revisão para ler as avaliações e retomar, suspender ou encerrar a sinalização.",
    ],
    button: "Abrir revisão",
  },
  "monitor.team_held": {
    subject: "O monitor de conteúdo pausou uma equipe para revisão",
    body: [
      "{team} é uma equipe nova e uma mensagem amostrada teve pontuação {score} ({verdict}). {rule} Pela política de pausa para revisão, nada da equipe sai: os e-mails que ela envia pela API e pelo SMTP são aceitos e ficam em espera, os e-mails na fila e as transmissões aguardam, novas transmissões são recusadas e o tenant da equipe no SES fica desativado onde os tenants estão ligados. Uma mensagem avaliada antes do envio fica em espera com as outras; uma avaliada depois do envio já tinha saído.",
      "O proprietário não recebe e-mail: o painel mostra o envio pausado aguardando revisão, e a API e o SMTP respondem como para qualquer envio aceito. Abra a página de revisão para liberar a equipe, o que envia os e-mails em espera, ou para suspendê-la por phishing.",
    ],
    button: "Abrir revisão",
    extra: {
      score: "Esta avaliação, sozinha, pausou a equipe: a pontuação de revisão é {line}.",
      young_domain:
        "Esta avaliação, sozinha, pausou a equipe: chegou a {line} quando o domínio de envio da equipe tinha menos de 7 dias ou idade desconhecida.",
      young_link:
        "Esta avaliação, sozinha, pausou a equipe: chegou a {line} em um e-mail com link para um destino novo registrado há menos de 7 dias.",
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
      held: "Ela fica pausada para revisão: os e-mails ficam em espera até você decidir, e o proprietário vê o envio como pausado aguardando revisão, sem receber e-mail sobre isso.",
      notHeld:
        "Ela não foi pausada: uma coincidência pausa uma equipe nova quando ela envia, e só quando inclui um endereço de e-mail, um cartão ou dois tipos de evidência e a pausa automática está ligada.",
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
      "{unjudged} de {samples} amostras sorteadas na última hora voltaram sem avaliação ({provider} · {model}). Uma amostra sem avaliação não muda o risco nem abre sinalização. Enquanto o avaliador falha, o e-mail de uma equipe nova enviado de um domínio com menos de 7 dias, ou de idade desconhecida, espera: o avaliador é chamado de novo por alguns minutos e depois o e-mail fica em espera para você em Confiança e segurança, onde {parked} estão agora. Todo o resto é enviado e avaliado depois.",
      "As causas comuns são um provedor limitando requisições ou fora do ar, uma chave de API inválida ou revogada, ou respostas que o monitor não conseguiu ler. O cartão Saúde do console mostra o percentual sem avaliação.",
    ],
    button: "Abrir console",
    muted: [
      "Enviado ao operador da instância no máximo a cada seis horas enquanto o percentual ficar acima de 20%, o provedor continuar recusando a chave de API ou a avaliação antes do envio desistir de algum e-mail.",
    ],
  },
  "monitor.destination_parked": {
    subject: "O monitor de conteúdo deixou em espera e-mails para um destino novo",
    body: [
      "{team} enviou e-mails para um destino que nunca tinha usado ({domain}), e o avaliador deu pontuação {score} ({verdict}). Esses e-mails estão em espera em Confiança e segurança, onde você os libera, o que os envia e torna o destino conhecido da equipe, ou os cancela.",
      "A equipe não fica pausada para revisão: o resto do e-mail dela continua saindo, e ela não fica sabendo. E-mails para o mesmo destino são avaliados antes do envio até que um seja liberado.",
    ],
    button: "Abrir lista de revisão",
    muted: ["Enviado ao operador da instância no máximo uma vez por dia por equipe."],
  },
  "monitor.media_blocked": {
    subject: "Monitor de conteúdo: o leitor de imagens recusou as imagens de um e-mail",
    body: [
      "O Amazon Bedrock se recusou a ler as imagens de um e-mail de {team} (HTTP 400). O Bedrock responde assim quando a detecção de abuso dele bloqueia uma imagem, o que inclui material de abuso sexual infantil. Nenhuma prévia dessas imagens fica guardada.",
      "Um e-mail que ainda não tinha sido enviado fica em espera em Confiança e segurança até você liberar ou cancelar; um avaliado depois do envio já foi entregue. Isso sozinho não deixa a equipe pausada para revisão, e ela não fica sabendo.",
    ],
    button: "Abrir lista de revisão",
    muted: ["Enviado ao operador da instância no máximo uma vez por dia por equipe."],
  },
  "monitor.destination_revoked": {
    subject: "Monitor de conteúdo: e-mail para um destino já liberado foi avaliado como phishing",
    body: [
      "{team} enviou e-mail para {domain}, um destino que e-mails anteriores tinham liberado na última semana, e o avaliador deu pontuação {score} ({verdict}) depois do envio. O destino deixou de estar liberado: e-mails para ele voltam a ser avaliados antes do envio e ficam em espera em Confiança e segurança com uma avaliação do tipo phishing, e nenhuma avaliação o libera de novo. Liberar e-mails para ele na lista de revisão libera.",
      "Isso sozinho não deixa a equipe pausada para revisão: o resto do e-mail dela continua saindo, e ela não fica sabendo.",
    ],
    button: "Abrir lista de revisão",
    muted: ["Enviado ao operador da instância no máximo uma vez por dia por equipe."],
  },
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

export const ptBRPhrases = {
  capUpToDay: "até {n} e-mails por dia",
  capUpToMonth: "até {n} e-mails por mês",
  capNone: "sem limite de envio",
} as const satisfies Record<MailPhraseKey, string>;
