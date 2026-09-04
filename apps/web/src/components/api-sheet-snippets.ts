/* Per-SDK snippets for the resource API sheets. Each snippet mirrors the real
   published SDK surface in sdks/millionsend-<lang> — only the resources every
   SDK implements (contacts, segments, topics, broadcasts, webhooks) get an entry here;
   the rest stay curl-only in api-sheet.tsx. Client setup follows the emails
   sheet's convention: placeholder key in the first section, reused after. */

export const LANGS = [
  "node",
  "python",
  "php",
  "ruby",
  "go",
  "rust",
  "java",
  "dotnet",
  "elixir",
] as const;
export type Lang = (typeof LANGS)[number];

type ResourceSnippets<Section extends string> = Record<Lang, Record<Section, string>>;

const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

export const CONTACTS_SNIPPETS: ResourceSnippets<"list" | "create" | "update"> = {
  node: {
    list: `import { MillionSend } from "millionsend";

const ms = new MillionSend("ms_xxxxxxxxx");

const { data, error } = await ms.contacts.list({ limit: 20 });`,
    create: `await ms.contacts.create({
  email: "steve.wozniak@gmail.com",
  firstName: "Steve",
  lastName: "Wozniak",
});`,
    update: `await ms.contacts.update({
  id: "${ID}",
  unsubscribed: true,
});`,
  },
  python: {
    list: `import millionsend

millionsend.api_key = "ms_xxxxxxxxx"

contacts = millionsend.Contacts.list(limit=20)`,
    create: `millionsend.Contacts.create({
    "email": "steve.wozniak@gmail.com",
    "first_name": "Steve",
    "last_name": "Wozniak",
})`,
    update: `millionsend.Contacts.update({
    "id": "${ID}",
    "unsubscribed": True,
})`,
  },
  php: {
    list: `$ms = MillionSend\\MillionSend::client('ms_xxxxxxxxx');

$contacts = $ms->contacts->list(['limit' => 20]);`,
    create: `$ms->contacts->create([
    'email' => 'steve.wozniak@gmail.com',
    'firstName' => 'Steve',
    'lastName' => 'Wozniak',
]);`,
    update: `$ms->contacts->update([
    'id' => '${ID}',
    'unsubscribed' => true,
]);`,
  },
  ruby: {
    list: `Millionsend.api_key = "ms_xxxxxxxxx"

contacts = Millionsend::Contacts.list(limit: 20)`,
    create: `Millionsend::Contacts.create(
  email: "steve.wozniak@gmail.com",
  first_name: "Steve",
  last_name: "Wozniak"
)`,
    update: `Millionsend::Contacts.update(
  id: "${ID}",
  unsubscribed: true
)`,
  },
  go: {
    list: `client := millionsend.NewClient("ms_xxxxxxxxx")

contacts, err := client.Contacts.List(&millionsend.ListOptions{Limit: 20})`,
    create: `contact, err := client.Contacts.Create(&millionsend.CreateContactRequest{
    Email:     "steve.wozniak@gmail.com",
    FirstName: "Steve",
    LastName:  "Wozniak",
})`,
    update: `unsubscribed := true

updated, err := client.Contacts.Update(&millionsend.UpdateContactRequest{
    Id:           "${ID}",
    Unsubscribed: &unsubscribed,
})`,
  },
  rust: {
    list: `let ms = MillionSend::new("ms_xxxxxxxxx");

let contacts = ms
    .contacts
    .list(Some(&ListOptions {
        limit: Some(20),
        ..Default::default()
    }))
    .await?;`,
    create: `let mut contact = CreateContactOptions::new("steve.wozniak@gmail.com");
contact.first_name = Some("Steve".into());
contact.last_name = Some("Wozniak".into());

ms.contacts.create(&contact).await?;`,
    update: `ms.contacts
    .update(
        "${ID}",
        &UpdateContactOptions {
            unsubscribed: Some(true),
            ..Default::default()
        },
    )
    .await?;`,
  },
  java: {
    list: `MillionSend ms = new MillionSend("ms_xxxxxxxxx");

ListResponse<Contact> contacts = ms.contacts().list(
    ListOptions.builder().limit(20).build()
);`,
    create: `ms.contacts().create(CreateContactOptions.builder()
    .email("steve.wozniak@gmail.com")
    .firstName("Steve")
    .lastName("Wozniak")
    .build());`,
    update: `ms.contacts().update(UpdateContactOptions.builder()
    .id("${ID}")
    .unsubscribed(true)
    .build());`,
  },
  dotnet: {
    list: `var ms = new MillionSendClient("ms_xxxxxxxxx");

var contacts = await ms.ContactListAsync(new ListOptions { Limit = 20 });`,
    create: `await ms.ContactAddAsync(new ContactCreateOptions
{
    Email = "steve.wozniak@gmail.com",
    FirstName = "Steve",
    LastName = "Wozniak",
});`,
    update: `await ms.ContactUpdateAsync(new ContactUpdateOptions
{
    Id = Guid.Parse("${ID}"),
    Unsubscribed = true,
});`,
  },
  elixir: {
    list: `client = MillionSend.client(api_key: "ms_xxxxxxxxx")

{:ok, contacts} = MillionSend.Contacts.list(client, limit: 20)`,
    create: `MillionSend.Contacts.create(client, %{
  email: "steve.wozniak@gmail.com",
  first_name: "Steve",
  last_name: "Wozniak"
})`,
    update: `MillionSend.Contacts.update(client, %{
  id: "${ID}",
  unsubscribed: true
})`,
  },
};

export const SEGMENTS_SNIPPETS: ResourceSnippets<"list" | "create" | "update"> = {
  node: {
    list: `import { MillionSend } from "millionsend";

const ms = new MillionSend("ms_xxxxxxxxx");

const { data, error } = await ms.segments.list({ limit: 20 });`,
    create: `await ms.segments.create({
  name: "Gmail users",
  filter: {
    match: "all",
    conditions: [{ field: "email", op: "ends_with", value: "@gmail.com" }],
  },
});`,
    update: `await ms.segments.update("${ID}", {
  name: "Gmail power users",
});`,
  },
  python: {
    list: `import millionsend

millionsend.api_key = "ms_xxxxxxxxx"

segments = millionsend.Segments.list(limit=20)`,
    create: `millionsend.Segments.create({
    "name": "Gmail users",
    "filter": {
        "match": "all",
        "conditions": [
            {"field": "email", "op": "ends_with", "value": "@gmail.com"}
        ],
    },
})`,
    update: `millionsend.Segments.update(
    "${ID}",
    {"name": "Gmail power users"},
)`,
  },
  php: {
    list: `$ms = MillionSend\\MillionSend::client('ms_xxxxxxxxx');

$segments = $ms->segments->list(['limit' => 20]);`,
    create: `$ms->segments->create([
    'name' => 'Gmail users',
    'filter' => [
        'match' => 'all',
        'conditions' => [
            ['field' => 'email', 'op' => 'ends_with', 'value' => '@gmail.com'],
        ],
    ],
]);`,
    update: `$ms->segments->update('${ID}', [
    'name' => 'Gmail power users',
]);`,
  },
  ruby: {
    list: `Millionsend.api_key = "ms_xxxxxxxxx"

segments = Millionsend::Segments.list(limit: 20)`,
    create: `Millionsend::Segments.create(
  name: "Gmail users",
  filter: {
    match: "all",
    conditions: [
      { field: "email", op: "ends_with", value: "@gmail.com" }
    ]
  }
)`,
    update: `Millionsend::Segments.update(
  "${ID}",
  name: "Gmail power users"
)`,
  },
  go: {
    list: `client := millionsend.NewClient("ms_xxxxxxxxx")

segments, err := client.Segments.List(&millionsend.ListOptions{Limit: 20})`,
    create: `segment, err := client.Segments.Create(&millionsend.CreateSegmentRequest{
    Name: "Gmail users",
    Filter: millionsend.SegmentFilter{
        Match: "all",
        Conditions: []millionsend.SegmentCondition{
            {Field: "email", Op: "ends_with", Value: "@gmail.com"},
        },
    },
})`,
    update: `segment, err := client.Segments.Update(
    "${ID}",
    &millionsend.UpdateSegmentRequest{Name: "Gmail power users"},
)`,
  },
  rust: {
    list: `let ms = MillionSend::new("ms_xxxxxxxxx");

let segments = ms
    .segments
    .list(Some(&ListOptions {
        limit: Some(20),
        ..Default::default()
    }))
    .await?;`,
    create: `let segment = CreateSegmentOptions {
    name: "Gmail users".into(),
    filter: SegmentFilter {
        match_: SegmentMatch::All,
        conditions: vec![SegmentCondition {
            field: "email".into(),
            op: "ends_with".into(),
            value: Some("@gmail.com".into()),
        }],
    },
};

ms.segments.create(&segment).await?;`,
    update: `ms.segments
    .update(
        "${ID}",
        &UpdateSegmentOptions {
            name: Some("Gmail power users".into()),
            ..Default::default()
        },
    )
    .await?;`,
  },
  java: {
    list: `MillionSend ms = new MillionSend("ms_xxxxxxxxx");

ListResponse<Segment> segments = ms.segments().list(
    ListOptions.builder().limit(20).build()
);`,
    create: `ms.segments().create(CreateSegmentOptions.builder()
    .name("Gmail users")
    .filter(SegmentFilter.builder()
        .match("all")
        .condition(new SegmentCondition("email", "ends_with", "@gmail.com"))
        .build())
    .build());`,
    update: `ms.segments().update(
    "${ID}",
    UpdateSegmentOptions.builder().name("Gmail power users").build()
);`,
  },
  dotnet: {
    list: `var ms = new MillionSendClient("ms_xxxxxxxxx");

var segments = await ms.SegmentListAsync(new ListOptions { Limit = 20 });`,
    create: `await ms.SegmentAddAsync(new SegmentCreateOptions
{
    Name = "Gmail users",
    Filter = new SegmentFilter
    {
        Match = SegmentMatch.All,
        Conditions = new List<SegmentCondition>
        {
            new() { Field = "email", Op = "ends_with", Value = "@gmail.com" },
        },
    },
});`,
    update: `await ms.SegmentUpdateAsync(
    Guid.Parse("${ID}"),
    new SegmentUpdateOptions { Name = "Gmail power users" }
);`,
  },
  elixir: {
    list: `client = MillionSend.client(api_key: "ms_xxxxxxxxx")

{:ok, segments} = MillionSend.Segments.list(client, limit: 20)`,
    create: `MillionSend.Segments.create(client, %{
  name: "Gmail users",
  filter: %{
    match: :all,
    conditions: [
      %{field: "email", op: "ends_with", value: "@gmail.com"}
    ]
  }
})`,
    update: `MillionSend.Segments.update(client, "${ID}", %{
  name: "Gmail power users"
})`,
  },
};

export const TOPICS_SNIPPETS: ResourceSnippets<"list" | "create" | "get"> = {
  node: {
    list: `import { MillionSend } from "millionsend";

const ms = new MillionSend("ms_xxxxxxxxx");

const { data, error } = await ms.topics.list();`,
    create: `await ms.topics.create({
  name: "Product updates",
  description: "New features and improvements",
  defaultSubscription: "opt_in",
});`,
    get: `const { data, error } = await ms.topics.get(
  "${ID}",
);`,
  },
  python: {
    list: `import millionsend

millionsend.api_key = "ms_xxxxxxxxx"

topics = millionsend.Topics.list()`,
    create: `millionsend.Topics.create({
    "name": "Product updates",
    "description": "New features and improvements",
    "default_subscription": "opt_in",
})`,
    get: `topic = millionsend.Topics.get(
    "${ID}"
)`,
  },
  php: {
    list: `$ms = MillionSend\\MillionSend::client('ms_xxxxxxxxx');

$topics = $ms->topics->list();`,
    create: `$ms->topics->create([
    'name' => 'Product updates',
    'description' => 'New features and improvements',
    'defaultSubscription' => 'opt_in',
]);`,
    get: `$topic = $ms->topics->get(
    '${ID}'
);`,
  },
  ruby: {
    list: `Millionsend.api_key = "ms_xxxxxxxxx"

topics = Millionsend::Topics.list`,
    create: `Millionsend::Topics.create(
  name: "Product updates",
  description: "New features and improvements",
  default_subscription: "opt_in"
)`,
    get: `topic = Millionsend::Topics.get(
  "${ID}"
)`,
  },
  go: {
    list: `client := millionsend.NewClient("ms_xxxxxxxxx")

topics, err := client.Topics.List()`,
    create: `topic, err := client.Topics.Create(&millionsend.CreateTopicRequest{
    Name:                "Product updates",
    Description:         "New features and improvements",
    DefaultSubscription: "opt_in",
})`,
    get: `topic, err := client.Topics.Get(
    "${ID}",
)`,
  },
  rust: {
    list: `let ms = MillionSend::new("ms_xxxxxxxxx");

let topics = ms.topics.list().await?;`,
    create: `let mut topic = CreateTopicOptions::new(
    "Product updates",
    TopicSubscription::OptIn,
);
topic.description = Some("New features and improvements".into());

ms.topics.create(&topic).await?;`,
    get: `let topic = ms
    .topics
    .get("${ID}")
    .await?;`,
  },
  java: {
    list: `MillionSend ms = new MillionSend("ms_xxxxxxxxx");

DataResponse<Topic> topics = ms.topics().list();`,
    create: `ms.topics().create(CreateTopicOptions.builder()
    .name("Product updates")
    .description("New features and improvements")
    .defaultSubscription(Subscription.OPT_IN)
    .build());`,
    get: `Topic topic = ms.topics().get(
    "${ID}"
);`,
  },
  dotnet: {
    list: `var ms = new MillionSendClient("ms_xxxxxxxxx");

var topics = await ms.TopicListAsync();`,
    create: `await ms.TopicAddAsync(new TopicCreateOptions
{
    Name = "Product updates",
    Description = "New features and improvements",
    DefaultSubscription = TopicSubscription.OptIn,
});`,
    get: `var topic = await ms.TopicRetrieveAsync(
    Guid.Parse("${ID}")
);`,
  },
  elixir: {
    list: `client = MillionSend.client(api_key: "ms_xxxxxxxxx")

{:ok, topics} = MillionSend.Topics.list(client)`,
    create: `MillionSend.Topics.create(client, %{
  name: "Product updates",
  description: "New features and improvements",
  default_subscription: :opt_in
})`,
    get: `{:ok, topic} = MillionSend.Topics.get(
  client,
  "${ID}"
)`,
  },
};

export const BROADCASTS_SNIPPETS: ResourceSnippets<"list" | "create" | "send"> = {
  node: {
    list: `import { MillionSend } from "millionsend";

const ms = new MillionSend("ms_xxxxxxxxx");

const { data, error } = await ms.broadcasts.list({ limit: 20 });`,
    create: `await ms.broadcasts.create({
  name: "Launch announcement",
  segmentId: "${ID}",
  from: "Acme <news@yourdomain.com>",
  subject: "We just launched",
  html: "<p>Big news!</p>",
});`,
    send: `await ms.broadcasts.send("${ID}", {
  scheduledAt: "in 1 hour",
});`,
  },
  python: {
    list: `import millionsend

millionsend.api_key = "ms_xxxxxxxxx"

broadcasts = millionsend.Broadcasts.list(limit=20)`,
    create: `millionsend.Broadcasts.create({
    "name": "Launch announcement",
    "segment_id": "${ID}",
    "from": "Acme <news@yourdomain.com>",
    "subject": "We just launched",
    "html": "<p>Big news!</p>",
})`,
    send: `millionsend.Broadcasts.send(
    "${ID}",
    scheduled_at="in 1 hour",
)`,
  },
  php: {
    list: `$ms = MillionSend\\MillionSend::client('ms_xxxxxxxxx');

$broadcasts = $ms->broadcasts->list(['limit' => 20]);`,
    create: `$ms->broadcasts->create([
    'name' => 'Launch announcement',
    'segmentId' => '${ID}',
    'from' => 'Acme <news@yourdomain.com>',
    'subject' => 'We just launched',
    'html' => '<p>Big news!</p>',
]);`,
    send: `$ms->broadcasts->send('${ID}', [
    'scheduledAt' => 'in 1 hour',
]);`,
  },
  ruby: {
    list: `Millionsend.api_key = "ms_xxxxxxxxx"

broadcasts = Millionsend::Broadcasts.list(limit: 20)`,
    create: `Millionsend::Broadcasts.create(
  name: "Launch announcement",
  segment_id: "${ID}",
  from: "Acme <news@yourdomain.com>",
  subject: "We just launched",
  html: "<p>Big news!</p>"
)`,
    send: `Millionsend::Broadcasts.send(
  "${ID}",
  scheduled_at: "in 1 hour"
)`,
  },
  go: {
    list: `client := millionsend.NewClient("ms_xxxxxxxxx")

broadcasts, err := client.Broadcasts.List(&millionsend.ListOptions{Limit: 20})`,
    create: `broadcast, err := client.Broadcasts.Create(&millionsend.CreateBroadcastRequest{
    Name:      "Launch announcement",
    SegmentId: "${ID}",
    From:      "Acme <news@yourdomain.com>",
    Subject:   "We just launched",
    Html:      "<p>Big news!</p>",
})`,
    send: `sent, err := client.Broadcasts.Send(
    "${ID}",
    &millionsend.SendBroadcastRequest{ScheduledAt: "in 1 hour"},
)`,
  },
  rust: {
    list: `let ms = MillionSend::new("ms_xxxxxxxxx");

let broadcasts = ms
    .broadcasts
    .list(Some(&ListOptions {
        limit: Some(20),
        ..Default::default()
    }))
    .await?;`,
    create: `let mut broadcast = CreateBroadcastOptions::new(
    "Acme <news@yourdomain.com>",
    "We just launched",
);
broadcast.name = Some("Launch announcement".into());
broadcast.segment_id = Some("${ID}".into());
broadcast.html = Some("<p>Big news!</p>".into());

ms.broadcasts.create(&broadcast).await?;`,
    send: `ms.broadcasts
    .send("${ID}", Some("in 1 hour"))
    .await?;`,
  },
  java: {
    list: `MillionSend ms = new MillionSend("ms_xxxxxxxxx");

ListResponse<Broadcast> broadcasts = ms.broadcasts().list(
    ListOptions.builder().limit(20).build()
);`,
    create: `ms.broadcasts().create(CreateBroadcastOptions.builder()
    .name("Launch announcement")
    .segmentId("${ID}")
    .from("Acme <news@yourdomain.com>")
    .subject("We just launched")
    .html("<p>Big news!</p>")
    .build());`,
    send: `ms.broadcasts().send(
    "${ID}",
    SendBroadcastOptions.builder().scheduledAt("in 1 hour").build()
);`,
  },
  dotnet: {
    list: `var ms = new MillionSendClient("ms_xxxxxxxxx");

var broadcasts = await ms.BroadcastListAsync(new ListOptions { Limit = 20 });`,
    create: `await ms.BroadcastAddAsync(new BroadcastCreateOptions
{
    Name = "Launch announcement",
    SegmentId = Guid.Parse("${ID}"),
    From = "Acme <news@yourdomain.com>",
    Subject = "We just launched",
    Html = "<p>Big news!</p>",
});`,
    send: `await ms.BroadcastSendAsync(
    Guid.Parse("${ID}"),
    scheduledAt: "in 1 hour"
);`,
  },
  elixir: {
    list: `client = MillionSend.client(api_key: "ms_xxxxxxxxx")

{:ok, broadcasts} = MillionSend.Broadcasts.list(client, limit: 20)`,
    create: `MillionSend.Broadcasts.create(client, %{
  name: "Launch announcement",
  segment_id: "${ID}",
  from: "Acme <news@yourdomain.com>",
  subject: "We just launched",
  html: "<p>Big news!</p>"
})`,
    send: `MillionSend.Broadcasts.send(
  client,
  "${ID}",
  scheduled_at: "in 1 hour"
)`,
  },
};

export const WEBHOOKS_SNIPPETS: ResourceSnippets<"list" | "create" | "update"> = {
  node: {
    list: `import { MillionSend } from "millionsend";

const ms = new MillionSend("ms_xxxxxxxxx");

const { data, error } = await ms.webhooks.list({ limit: 20 });`,
    create: `await ms.webhooks.create({
  endpoint: "https://example.com/webhooks/millionsend",
  events: ["email.delivered", "email.bounced"],
});`,
    update: `await ms.webhooks.update("${ID}", {
  status: "disabled",
});`,
  },
  python: {
    list: `import millionsend

millionsend.api_key = "ms_xxxxxxxxx"

webhooks = millionsend.Webhooks.list(limit=20)`,
    create: `millionsend.Webhooks.create({
    "endpoint": "https://example.com/webhooks/millionsend",
    "events": ["email.delivered", "email.bounced"],
})`,
    update: `millionsend.Webhooks.update({
    "webhook_id": "${ID}",
    "status": "disabled",
})`,
  },
  php: {
    list: `$ms = MillionSend\\MillionSend::client('ms_xxxxxxxxx');

$webhooks = $ms->webhooks->list(['limit' => 20]);`,
    create: `$ms->webhooks->create([
    'endpoint' => 'https://example.com/webhooks/millionsend',
    'events' => ['email.delivered', 'email.bounced'],
]);`,
    update: `$ms->webhooks->update('${ID}', [
    'status' => 'disabled',
]);`,
  },
  ruby: {
    list: `Millionsend.api_key = "ms_xxxxxxxxx"

webhooks = Millionsend::Webhooks.list(limit: 20)`,
    create: `Millionsend::Webhooks.create(
  endpoint: "https://example.com/webhooks/millionsend",
  events: ["email.delivered", "email.bounced"]
)`,
    update: `Millionsend::Webhooks.update(
  "${ID}",
  status: "disabled"
)`,
  },
  go: {
    list: `client := millionsend.NewClient("ms_xxxxxxxxx")

webhooks, err := client.Webhooks.List(&millionsend.ListOptions{Limit: 20})`,
    create: `webhook, err := client.Webhooks.Create(&millionsend.CreateWebhookRequest{
    Endpoint: "https://example.com/webhooks/millionsend",
    Events:   []string{"email.delivered", "email.bounced"},
})`,
    update: `updated, err := client.Webhooks.Update(
    "${ID}",
    &millionsend.UpdateWebhookRequest{Status: "disabled"},
)`,
  },
  rust: {
    list: `let ms = MillionSend::new("ms_xxxxxxxxx");

let webhooks = ms
    .webhooks
    .list(Some(&ListOptions {
        limit: Some(20),
        ..Default::default()
    }))
    .await?;`,
    create: `ms.webhooks
    .create(&CreateWebhookOptions {
        endpoint: "https://example.com/webhooks/millionsend".into(),
        events: vec!["email.delivered".into(), "email.bounced".into()],
        signing_secret: None,
    })
    .await?;`,
    update: `ms.webhooks
    .update("${ID}", &UpdateWebhookOptions {
        status: Some(WebhookStatus::Disabled),
        ..Default::default()
    })
    .await?;`,
  },
  java: {
    list: `MillionSend ms = new MillionSend("ms_xxxxxxxxx");

ListResponse<Webhook> webhooks = ms.webhooks().list(
    ListOptions.builder().limit(20).build()
);`,
    create: `ms.webhooks().create(CreateWebhookOptions.builder()
    .endpoint("https://example.com/webhooks/millionsend")
    .events(WebhookEvent.EMAIL_DELIVERED, WebhookEvent.EMAIL_BOUNCED)
    .build());`,
    update: `ms.webhooks().update(
    "${ID}",
    UpdateWebhookOptions.builder().status("disabled").build()
);`,
  },
  dotnet: {
    list: `var ms = new MillionSendClient("ms_xxxxxxxxx");

var webhooks = await ms.WebhookListAsync(new ListOptions { Limit = 20 });`,
    create: `await ms.WebhookCreateAsync(new WebhookCreateOptions
{
    Endpoint = "https://example.com/webhooks/millionsend",
    Events = new List<string> { "email.delivered", "email.bounced" },
});`,
    update: `await ms.WebhookUpdateAsync(
    Guid.Parse("${ID}"),
    new WebhookUpdateOptions { Status = WebhookStatus.Disabled }
);`,
  },
  elixir: {
    list: `client = MillionSend.client(api_key: "ms_xxxxxxxxx")

{:ok, webhooks} = MillionSend.Webhooks.list(client, limit: 20)`,
    create: `MillionSend.Webhooks.create(client, %{
  endpoint: "https://example.com/webhooks/millionsend",
  events: ["email.delivered", "email.bounced"]
})`,
    update: `MillionSend.Webhooks.update(client, "${ID}", %{status: "disabled"})`,
  },
};
