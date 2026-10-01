# Pi setup

Extensions, themes, and settings for the [Pi](https://github.com/earendil-works/pi) coding agent. Pi reads them from `~/.pi/agent`, so that's where the repository goes. [`extensions/README.md`](extensions/README.md) lists each extension.

## Install

You need Pi and Node 24 or later.

```sh
git clone https://github.com/0x7067/pi-setup ~/.pi/agent
cd ~/.pi/agent
cp .env.example .env
npm ci --ignore-scripts
(cd extensions/file-search && npm ci --ignore-scripts)
pi update --extensions
```

Fill in `.env`, then add provider credentials from inside Pi. `pi update --extensions` installs the packages listed in `settings.json`.

## Themes

`settings.json` selects `oxocarbon-dark`. `oxocarbon-light` is also in `themes/`.

## Check

```sh
npm run check
npm test
```

## License

Most extensions are forked from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) and stay under its MIT license, in [`LICENSE.my-pi-setup`](LICENSE.my-pi-setup). `ask-user-question` is forked from [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono) and keeps its MIT license.
