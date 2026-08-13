# @millionsend/i18n

One catalog, three renderers: the dashboard, MillionSend's own transactional emails, and the
hosted unsubscribe/preferences pages all read from `messages/` (ICU MessageFormat, consumed
via next-intl).

## Rules

- **No user-facing string literals outside `messages/`** — anywhere, from the first commit.
- `en` is the source of truth. `pt-BR` is a launch locale and must stay complete.
- All other locales are community-translated via Weblate (git-synced pull requests) — see
  CONTRIBUTING for the translator flow. Machine-generated drafts enter as "needs review" and
  are promoted only by native-speaker review.
- The public REST API is deliberately NOT localized: stable machine-readable error codes with
  English messages (programs parse codes; humans read docs).
- Recipient-facing pages (unsubscribe/preferences) resolve locale from `Accept-Language` —
  the visitor is the recipient, not our customer.
