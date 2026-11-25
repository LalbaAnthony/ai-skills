# Example: one delivery, three audiences

The same facts, written as a delivery note for each audience. The facts are fictional.

## Facts gathered

| Fact | Source | Verified |
| --- | --- | --- |
| Checkout goes from 5 steps to 3; guests can order without an account | conversation, MR !142 | yes |
| Guest orders are labeled "Guest" in the back office | MR !142 | yes |
| Confirmation emails failed for names with accents: the queue worker crashed on encoding; fixed, with a retry policy | conversation, commit `a1b2c3d`, ticket #318 | yes |
| Branch `feat/checkout-v2`, 7 commits since `origin/develop`, merged into `develop` then `main` through MR !142, tag `v2.4.0` | git-state script, platform | yes |
| Pipeline #5512 green | platform | yes |
| Production serves 2.4.0 since 24 November 2026 | GET `https://shop.example.com/version` | yes |
| Migration adds `orders.guest_token`; new variable `MAIL_QUEUE_RETRIES` | diff | yes |
| `npm test`: 214 passed | run during the session | yes |
| End-to-end checkout test not run | conversation | yes |
| Address autocomplete does not show on Safari for iOS 15 | conversation (known bug, not fixed) | yes |
| Emails reach Outlook mailboxes | user's assumption | no |
| A guest cart expires after 24 hours (by design) | conversation | yes |
| Whether B2B customers may use guest checkout is undecided | conversation | yes |
| Next: account page redesign | conversation | yes |
| Scripts `dev`, `test` and `test:e2e` | `package.json` | yes |
| Implementation details, abandoned approach, rollback target `v2.3.2` | conversation, diff, tags | yes |
| Autocomplete bug caused by a `:has()` selector | developer's guess | no |

## Client

The new checkout has been live since 24 November 2026.

### Delivered

- Ordering now takes 3 steps instead of 5.
- Your customers can order without creating an account.
- Order confirmation emails are now sent reliably, including to customers whose name contains accents.

### What changes for you

- Orders placed without an account appear in your back office with the mention "Guest".

### What you need to do

- Please review the wording of the new confirmation email and tell us if you want changes.

### Good to know

- A cart started without an account is kept for 24 hours.

### Next steps

- We are starting the redesign of the customer account page.

**To settle before sending** (for the user, not part of the report)

- Left out (bad news): address autocomplete does not show on Safari for iOS 15. Mention it to the client?
- Left out (unverified): delivery of confirmation emails to Outlook mailboxes has not been checked.

## Project manager

**Overall status:** on track; the new checkout is in production.

### Delivered

- Checkout reduced from 5 steps to 3, with ordering possible without an account.
- Order confirmation emails are sent reliably again.

### Key technical points

- The database gained a field to recognize orders placed without an account. It is added automatically at deployment, and must be taken into account by any future data export.
- Email sending now retries automatically when it fails, instead of losing the email. The number of attempts is a server setting.

### Remaining work

- Fix the address autocomplete on Safari for iOS 15.
- Run the full end-to-end test of the checkout.

### Risks and blockers

- On older iPhones (iOS 15), address autocomplete does not show: customers have to type their address in full.

### Decisions needed

- Should B2B customers be allowed to order without an account?

### For the technical team

- Checkout: MR !142, branch `feat/checkout-v2`, tag `v2.4.0`, pipeline #5512.
- Emails: commit `a1b2c3d`, ticket #318, variable `MAIL_QUEUE_RETRIES`.
- Database: migration adding `orders.guest_token`.

**To settle before sending** (for the user, not part of the report)

- Left out (unverified): delivery of confirmation emails to Outlook mailboxes has not been checked.

## Developer

### Context

Checkout v2 (3 steps, guest checkout) and fix of ticket #318 (confirmation emails lost for names with accents). Out of scope: account page redesign.

### Repository state

- `feat/checkout-v2`, 7 commits since `origin/develop`, merged into `develop` then `main` through MR !142; tag `v2.4.0`; pipeline #5512 green.
- Working tree clean, no stash, up to date with the remote.
- Production serves 2.4.0 (GET `/version`, checked 2026-11-25).

### Done

- Checkout: steps 2 to 4 merged into one form; guest checkout through a `guest_token` stored on the order instead of a session-only cart, so that a reload no longer loses the cart.
- Emails (#318, `a1b2c3d`): the worker decoded names as Latin-1 and crashed on accents; now UTF-8 throughout, plus a retry with exponential backoff, attempts from `MAIL_QUEUE_RETRIES`.

### Remaining work

1. Safari for iOS 15: the address autocomplete dropdown does not render. Suspected cause, a `:has()` selector in the component styles (unverified). Start there.
2. Run the end-to-end checkout test.
3. Check delivery to Outlook mailboxes (unverified).

### Resume the work

```bash
git switch main && git pull
npm ci
npm run dev
npm test
npm run test:e2e
```

### Tests

- `npm test`: 214 passed, run 2026-11-25.
- `npm run test:e2e`: not run.
- Not covered: email delivery to real mailboxes.

### Pitfalls and assumptions

- Tried keeping the guest cart in the session only: lost on reload behind the load balancer; abandoned for `guest_token`.
- A guest cart expires after 24 hours by design (`GUEST_CART_TTL` constant).

### Deployment

- Migration adding `orders.guest_token` (nullable, no backfill); runs before the new code starts.
- New variable `MAIL_QUEUE_RETRIES`, set in production.
- Rollback: redeploy `v2.3.2`; the column can stay, the old code ignores it.
