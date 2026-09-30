# Reasoning effort with Hermes

Some models can be asked to think harder before answering. When the model you have selected supports
it, a **Reasoning** control appears in the composer next to the model picker, offering the levels
that model actually accepts. Hermes uses its default reasoning level unless you choose another one.

## What the levels mean for your setup

The list is not the same for every model. T3 Code reads the model database Hermes already keeps on
disk to decide which models can reason at all, and trims the list where a provider refuses the
higher levels. If a model cannot reason, no control appears rather than one that does nothing. If a
model is forced to think, the control is hidden rather than offering an off option.

Custom proxy endpoints also support this control for recognized OpenAI, Claude, and Gemini models.
When the proxy has no catalogue entry, T3 Code checks the original model vendor's data and uses its
reasoning limits.

If Hermes has not yet built its model database, the control is hidden rather than guessed at. It
appears once Hermes has refreshed that data.

## Where the setting is saved

Choosing a level records it in your own Hermes configuration, against that specific model. This is
the same file the `hermes` command line reads, so a level you pick in T3 Code is the level your
terminal sessions use, and vice versa. Nothing else in that file is changed, and a configuration
file that cannot be read is never overwritten.

The level applies from your next message, not to a reply already in progress.

## Making it take effect

Hermes v0.21.4 or newer is needed. Older versions still show the control and save your choice, but
ignore it while talking to T3 Code and keep using their own default. Update Hermes from its provider
card in Settings, or with `hermes update`.
