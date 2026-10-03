# Keep Hermes patches in place

A few T3 Code features need changes to Hermes itself that Hermes has not shipped yet. T3 Code
carries those changes as patches, and the Patches tab of the Hermes panel shows whether your Hermes
has each one. On web and desktop, the clock button in the sidebar footer opens the panel; Patches
is the third tab. On mobile, open **Settings → Hermes → Patches**.

On web and desktop, the profile selector chooses which configured Hermes installation the tab
checks and changes. Profiles using the same installation share its patches. Mobile uses the
default Hermes installation.

Each patch shows one of three states:

- **Applied**: your Hermes has the change.
- **Not applied**: it fits your Hermes. **Apply** adds it.
- **Doesn't apply**: the patch was made for a different Hermes version. Update Hermes first. If it
  still doesn't apply, Hermes has moved past the patch; wait for a T3 Code update that carries a
  rebased one.

**Remove** takes an applied patch back out. Applying or removing affects new Hermes sessions; a
chat that is already running keeps the Hermes it started with. A patch to the Hermes gateway, such
as the one for webhook runs in profiles, takes effect once you restart the gateway with
`hermes gateway restart`.

## Things to know

- Patches need Hermes installed from a git checkout, the same kind of install that can update
  itself. Package-manager and container installs show why the tab has nothing to do.
- Updating Hermes keeps applied patches. If an update leaves a patch no longer fitting, the tab
  shows it as **Doesn't apply** rather than failing the update.
- If the tab warns about a detached HEAD, your Hermes checkout is pinned to one commit and updates
  cannot move it. Run `git checkout main` in the checkout, then update Hermes.
