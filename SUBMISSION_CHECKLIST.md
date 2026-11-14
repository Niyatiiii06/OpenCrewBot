# Submission checklist

## Before you record

- [ ] Fork https://github.com/Studio1-OSS/OpenCrewBot on GitHub (the Fork button), so the repository shows "forked from Studio1-OSS/OpenCrewBot".
- [ ] `pnpm install`, `pnpm test` (22 pass), `pnpm dev`, then `node tests/e2e-mock.mjs` in mock mode (29 pass).
- [ ] Add `GROQ_API_KEY` and `GEMINI_API_KEY` to `.env`. Restart. Models page shows both "configured".
- [ ] Send "hello" to any agent: a real reply, with the model name under it.
- [ ] Integrations page: press **Test connection** on GitHub and Web search. Optional: add Gmail (address + app password) and test it.
- [ ] Run the seven demos in `docs/DEMO_SCRIPT.md` once without recording. Note anything that fails.
- [ ] Update the "Verified so far" column in `docs/LIVE_VS_MOCKED.md` with what you actually saw.
- [ ] Add your own screenshots or logs of the live runs to `docs/TEST_EVIDENCE.md`.

## Deliverables

- [ ] Forked repository, pushed, public
- [ ] README and `docs/ARCHITECTURE.md`
- [ ] `docs/FEATURE_AUDIT.md`
- [ ] Demo video, 5 to 10 minutes, link added to the README
- [ ] `docs/TEST_EVIDENCE.md` (failure recovery and approval enforcement included)
- [ ] `docs/LIVE_VS_MOCKED.md`
- [ ] `docs/COSTS_AND_LICENCES.md`
- [ ] `docs/LIMITATIONS.md`
- [ ] `LICENSE` (MIT) still present and unchanged

## Never commit

- [ ] `.env` (check: `git ls-files | findstr /i "env"` shows only `.env.example`)
- [ ] the `data/` folder
