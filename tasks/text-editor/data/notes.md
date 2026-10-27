# Launch plan

Our launch is on Friday.
Everything below needs an owner by Wednesday.

## Product

- [x] Freeze the feature set
- [x] Final copy for the pricing page
- [ ] TODO: record the 90-second demo video
- [ ] Update screenshots in the docs (light and dark)
- [ ] TODO: check the onboarding emails render in Outlook

## Engineering

1. Cut the release branch on Tuesday at 10:00.
2. Run the full regression suite on the release branch.
3. Load test the signup endpoint at 5x normal traffic.
4. TODO: rotate the staging API keys before the demo.
5. Prepare the rollback runbook and share it in #eng.

```bash
git checkout -b release/2.0
npm run test:all
npm run deploy -- --env=staging
```

## Marketing

The announcement goes out at 09:00 PT on Friday, followed by
the newsletter at 11:00 and social posts throughout the day.

| Channel     | Owner | Status      |
|-------------|-------|-------------|
| Blog post   | Mira  | In review   |
| Newsletter  | Jon   | Drafting    |
| Product Hunt| Sam   | Scheduled   |
| Social      | Mira  | Not started |

TODO: confirm the Product Hunt hunter by Thursday.

## Support

- Add a "What's new" article to the help center.
- Brief the support team on Thursday afternoon.
- Prepare canned replies for the five most likely questions.

## Risks

> If the payments provider migration slips, we launch without
> annual plans and add them the week after.

- **Payments**: migration still running in staging.
- **Docs**: two pages still describe the old setup flow.
- **Capacity**: support is short one person on Friday.

## After launch

- Monday: review signups and activation.
- Tuesday: retro with the whole team.
- Wednesday: decide on the annual plan rollout.

Notes from the last sync:
the demo video should show the new dashboard first,
then the integrations, then pricing. Keep it under 90 seconds.
