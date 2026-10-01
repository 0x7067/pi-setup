# Pi setup

Extensions and settings for the [Pi](https://github.com/earendil-works/pi) coding agent. Pi reads them from `~/.pi/agent`, so that's where the repository goes. [`extensions/README.md`](extensions/README.md) lists each extension.

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

## Check

```sh
npm run check
npm test
```

## License

Part of this repository is forked from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) and stays under its MIT license, in [`LICENSE.my-pi-setup`](LICENSE.my-pi-setup).
