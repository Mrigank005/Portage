# Portage webhook relay

PayPal delivers webhooks only to a public HTTPS URL, and the app being tested runs on a developer's laptop. This relay sits in between:

1. Portage picks a long random channel name and registers `https://<relay>/hooks/<channel>` as a webhook in the tester's **own** PayPal sandbox app.
2. PayPal posts events to the relay, which keeps the body byte for byte, with PayPal's signature headers.
3. Portage, on the tester's machine, long-polls `/channels/<channel>/events` and forwards each event to the local app. The app verifies the signature with PayPal itself, as it would in production.

The relay never verifies, changes or acts on events and holds no credentials. Events are sandbox data, kept in memory for at most a day (100 per channel). It has no dependencies: `node server.mjs`.

Deployed on Render from [`render.yaml`](../../render.yaml). Tests: `npm test -w apps/webhook-relay`.
