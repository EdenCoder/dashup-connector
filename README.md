# Dashup connector

The desktop connector for [Dashup](https://dashup.com), and its `dashup` command. It runs beside your editor on macOS, Windows and Linux, reads the conversations your coding agents keep on that computer, and shows them on your phone: what is working, what needs you, and the conversation itself. From the phone you can reply, answer approvals and questions, start a session or open a terminal in a project.

It pairs with the Dashup app through Dashup Cloud, a paid hosted service that carries encrypted traffic between your devices. The app and Dashup Cloud are not in this repository.

```sh
npx @dashup/connector pair
```

The [connector's README](apps/connector/README.md) covers which agents it reads, what the phone can control and where the connector keeps its state.

## Encryption

Project names and paths, conversations, approvals, commands, terminal bytes and attachments are encrypted on your devices before they leave. The content key goes from the computer to the phone in the pairing QR code, so Dashup Cloud handles only ciphertext, plus the account, device and routing metadata it needs to deliver it.

The encryption lives in [`packages/protocol`](packages/protocol), which the app uses too:

| File                | Covers                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `src/crypto.ts`     | XChaCha20-Poly1305 envelopes authenticated with their routing fields, and the pairing code |
| `src/session.ts`    | Live session packets: conversation pages, commands, results and terminal bytes             |
| `src/attachment.ts` | Files, sealed in frames that are each authenticated and bound to the whole file            |

## Build and test

Use Node 24 and pnpm 10.

```sh
pnpm install
pnpm build
pnpm test
node apps/connector/dist/index.js --help
```

`pnpm build` bundles the connector, `packages/protocol` and Parcae's client into `apps/connector/dist/index.js`, the file npm installs as `dashup`. The workflow test in the connector's README needs Dashup Cloud's API, so it is not here.

| Path                               | Contents                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/connector`                   | The connector, its Claude Code plugin (`claude/`) and its Pi package (`pi/`)                |
| `packages/protocol`                | Wire types and device-side encryption                                                       |
| `submodules/parcae/packages/sdk`   | A copy of the client of [Parcae](https://github.com/EdenCoder/parcae), which Dashup runs on |
| `submodules/parcae/packages/model` | A copy of Parcae's models, which its client uses                                            |

## Changes

This repository mirrors the connector from Dashup's private monorepo, one commit per npm release, tagged with its version. Changes land there first, so pull requests here get ported over rather than merged. Issues are welcome.

## License

MIT; see [LICENSE](LICENSE). Parcae's packages carry their own MIT notices.
