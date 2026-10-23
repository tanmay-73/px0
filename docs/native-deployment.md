# Deploy px0 natively on a Linux machine

Native deployment runs px0 as your regular Linux user. Its integrated terminals
run on the host, with access to that user's repositories, installed development
tools, shell configuration, and available credentials. This is useful when you
want Node, Go, Python, coding agents, or other host tools in the browser terminal.

This guide uses `10.20.7.180:7777` and `/mnt/nvme1/Projects`, matching the machine
used in the [Docker guide](deployment.md). Replace the address and paths on
another machine. These are instructions only; creating this guide does not
switch the running Docker deployment to native mode.

## 1. Choose Docker or native deployment

| Concern | Native | Supplied Docker deployment |
| --- | --- | --- |
| Application process | Runs as the deployment user on the host | Runs as UID 1000 inside the container |
| Integrated terminal | Host shell and tools | Container shell and installed image tools |
| Repositories | Direct filesystem access | Host directory mounted into the container |
| Git configuration | User's normal configuration | Mounted `.gitconfig`, plus separately configured credentials |
| Settings/state | User's home or XDG directories | Persistent container-home volume |
| Startup | systemd user service in this guide | Docker Compose and restart policy |
| Updating | Replace binary, restart service | Rebuild image, recreate container |

Use one deployment per address/port. Native and Docker instances cannot both
own `10.20.7.180:7777`.

With `-terminal`, anyone who can reach px0 can run commands as its Linux user.
That includes access to files and credentials available to that user. Use a
trusted LAN or private VPN; provide authentication and TLS before access from
untrusted networks. Do not run px0 as root. `-roots` limits workbench directory
browsing and opening; it does not restrict the host shell's permissions.

## 2. Prepare the machine and user

Use a Linux machine with systemd for the persistent-service steps below. Run
the application and `systemctl --user` commands as the regular user who owns the
repositories. Use `sudo` only for machine administration where shown.

Check the network, repository directory, and current port owner:

```bash
ip -brief address
ls -ld /mnt/nvme1/Projects
sudo ss -ltnp 'sport = :7777'
```

On the current machine the Ethernet interface is `eno1` with address
`10.20.7.180`. Use the target machine's actual address and reserve it through
DHCP or your normal static-IP setup. Do not reuse the same address on two hosts.

If replacing the existing Docker deployment, stop it from its checkout:

```bash
cd /mnt/nvme1/Projects/px0
docker compose down
```

This retains the Docker home volume and repository files. It stops container
terminals. If an unrelated application owns the port, choose another port
instead of stopping that application.

## 3. Install the binary

Choose a published release or build your current checkout. Use the source-build
option when deploying local changes that have not been released.

### Option A: install a published release

From a trusted checkout, review and run its installer, targeting your user bin
directory explicitly:

```bash
cd /path/to/px0
less install.sh
INSTALL_DIR="$HOME/.local/bin" sh ./install.sh
"$HOME/.local/bin/px0" -version
```

The installer downloads a published binary for the host platform. It does not
build this checkout or include its uncommitted changes. For a specific release,
set the installer's `VERSION` variable as well.

### Option B: build the current checkout

The current `go.mod` requires Go 1.25. The frontend requires Bun and its npm
dependencies. Install Go using the [official Go installation guide](https://go.dev/doc/install)
and Bun using the [official Bun installation guide](https://bun.sh/docs/installation).
You also need Git. If using `make build`, install Make and Node.js as well:
that target invokes the frontend script through `node`.

Check the build tools:

```bash
go version
bun --version
git --version
```

Build directly with Bun and Go:

```bash
cd /mnt/nvme1/Projects/px0
git status --short
bun install
bun scripts/build-web.js
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o ./px0 .
./px0 -version
```

Frontend output is embedded in the binary. Always rebuild it before compiling
when frontend sources or dependencies change. Building just `go build` in a
fresh checkout can fail because the generated frontend is missing.

Install the result without writing over an executable that may be running:

```bash
install -d "$HOME/.local/bin"
install -m 0755 ./px0 "$HOME/.local/bin/px0.new"
mv -f "$HOME/.local/bin/px0.new" "$HOME/.local/bin/px0"
"$HOME/.local/bin/px0" -version
```

The service below uses this exact path, so it does not depend on which `px0`
your interactive `PATH` finds. A single installed binary is enough at runtime;
Bun, Node, and Go are build tools unless your projects need them themselves.

## 4. Try it in the foreground

First ensure port `7777` is free. Run:

```bash
"$HOME/.local/bin/px0" \
  -host 10.20.7.180 \
  -port 7777 \
  -no-open \
  -no-update \
  -terminal \
  -roots /mnt/nvme1/Projects
```

With no positional directory argument, px0 serves the workbench and lists
repositories under the configured root. `-no-open` avoids launching a browser
on the server. `-no-update` keeps this managed deployment on the binary you
installed. `-terminal` enables terminal access on the non-loopback address.
Remove it to keep remote shell access disabled.

Visit `http://10.20.7.180:7777` from another device on the LAN. Open a repository
and its terminal, and check `pwd`, `id`, and tools such as `node --version` or
`go version` when installed. Terminal commands run on this host.

Press `Ctrl+C` in the launch terminal before proceeding to systemd. Otherwise
the foreground instance will conflict with the service's port.

For local-only access, use `-host 127.0.0.1`. For a single project instead of
the workbench, pass its directory as the positional argument and omit `-roots`;
the health endpoint then changes from `/api/wb/ping` to `/api/meta`.

## 5. Create a systemd user service

Create or edit the unit as the deployment user. If `px0.service` already exists,
inspect and back it up before replacing it:

```bash
systemctl --user cat px0.service
mkdir -p "$HOME/.config/systemd/user"
```

The first command can report that no service exists on a fresh installation.
Save the following as `~/.config/systemd/user/px0.service`:

```ini
[Unit]
Description=px0 native workbench

[Service]
Type=simple
WorkingDirectory=/mnt/nvme1/Projects
Environment="PATH=%h/.local/bin:%h/.bun/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"
Environment=SHELL=/bin/bash
ExecStart=%h/.local/bin/px0 -host 10.20.7.180 -port 7777 -no-open -no-update -terminal -roots /mnt/nvme1/Projects
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

Change both repository paths and the host address for another machine. `%h`
is systemd's home-directory specifier. Use absolute paths for additional tools;
the unit's `Environment=` values are not shell expressions and do not expand
`$HOME` or `$PATH`. Keep shell arguments and flags in `ExecStart` before any
positional project directory.

`KillMode=control-group` stops the service's workspace processes and terminals
together. `Restart=on-failure` retries a failed process, including a startup
attempt before the configured Ethernet address is ready. It does not provide
HTTP health monitoring. See systemd's
[execution environment reference](https://www.freedesktop.org/software/systemd/man/260/systemd.exec.html)
for unit environment behavior.

Load and start the unit:

```bash
systemctl --user daemon-reload
systemctl --user enable --now px0.service
systemctl --user status px0.service --no-pager
journalctl --user -u px0.service -n 50 --no-pager
```

To start the user manager at boot and retain it after logout, enable lingering:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

Expect `Linger=yes`. This behavior is documented in
[loginctl](https://www.freedesktop.org/software/systemd/man/257/loginctl.html).
Repository mounts and the installed binary must also be available at boot.
Encrypted home directories or disks mounted only during an interactive login
may require a different startup arrangement.

## 6. Verify service and network access

```bash
systemctl --user is-active px0.service
curl --noproxy '*' --max-time 10 --fail http://10.20.7.180:7777/api/wb/ping
curl --noproxy '*' --max-time 10 --fail -o /dev/null -w 'HTTP %{http_code}\n' http://10.20.7.180:7777/
sudo ss -ltnp 'sport = :7777'
```

Expect an active service, `"workbench":true`, and HTTP `200`. Repeat the browser
test from a second LAN device to verify the network path, not just the local
listener. Allow the configured TCP port through the host and network firewall
for the clients you intend to use. Check VLANs, routing, Wi-Fi client isolation,
or a browser proxy if the host works but a second device cannot connect.

The browser terminal should report the host user's identity. Reloading the
page preserves running terminals while the server stays running; restarting
the service ends them.

## 7. Make host tools and credentials available

A systemd user service does not automatically run your login shell setup.
The example `PATH` includes common user, Bun, and Go locations, but you must
add your actual tool installation directories when different.

Bash terminals load the user's `.bashrc` through px0's shell integration.
Node installed with a version manager may become available there after its
normal initialization. Tools started directly by px0, including language
servers, also need to be discoverable in the service environment. After changing
the unit, run `daemon-reload` and restart the service; test the resulting terminal
and language-server behavior separately.

Check Git as the deployment user:

```bash
git config --global user.name
git config --global user.email
git -C /mnt/nvme1/Projects/px0 remote -v
```

Native Git uses that user's configuration and credential setup. An SSH agent,
desktop keyring, or session-specific environment may be unavailable to a service
started at boot. Configure the credential method deliberately; being the same
user does not guarantee every interactive-session credential helper is usable.
Avoid putting secrets directly in a unit file or committing them to the checkout.

## 8. Update and roll back

For a source-managed deployment, get the intended changes into the checkout and
build a new binary using section 3. Keep a copy of the installed version before
replacing it:

```bash
cp -p "$HOME/.local/bin/px0" "$HOME/.local/bin/px0.rollback"
```

Install the new binary using the `.new` plus `mv` steps, then restart and verify:

```bash
systemctl --user restart px0.service
systemctl --user status px0.service --no-pager
curl --noproxy '*' --max-time 10 --fail http://10.20.7.180:7777/api/wb/ping
```

Replacing the file does not replace an already running process; restart is
required. Rebuilding the frontend is required for frontend changes. Keep
`-no-update` in the service when you want explicit control over releases.

For a failed update, restore the saved binary and restart:

```bash
install -m 0755 "$HOME/.local/bin/px0.rollback" "$HOME/.local/bin/px0.new"
mv -f "$HOME/.local/bin/px0.new" "$HOME/.local/bin/px0"
systemctl --user restart px0.service
```

Rollback restores application code, not repository edits or state changes.
Save terminal work before any restart.

## 9. Back up native state

By default px0 stores settings, workbench history, and related state in
`~/.px0`. When configured, it uses `$XDG_CONFIG_HOME/px0` for configuration and
`$XDG_STATE_HOME/px0` for state. Check the actual service environment before
choosing backup paths. Back up repositories separately, including uncommitted
and untracked files, and retain the installed binary and service unit.

For a deployment using the default location:

```bash
PX0_BACKUP_DIR="$HOME/px0-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$PX0_BACKUP_DIR"
systemctl --user stop px0.service
if [ -d "$HOME/.px0" ]; then
  cp -a "$HOME/.px0" "$PX0_BACKUP_DIR/"
fi
cp -p "$HOME/.config/systemd/user/px0.service" "$PX0_BACKUP_DIR/"
cp -p "$HOME/.local/bin/px0" "$PX0_BACKUP_DIR/"
systemctl --user start px0.service
```

Keep backups outside the application checkout and copy them off the machine.
Protect them as private data because settings can include tokens. To restore,
stop px0, restore state into the deployment user's corresponding directories,
ensure ownership matches that user, restore the binary/unit, reload systemd,
and start the service. Review paths before migration to a different host.

## 10. Switch between Docker and native deployment

### Docker to native

1. Save work and back up Docker state using the [Docker guide](deployment.md#9-back-up-and-restore).
2. Run `docker compose down` from the Compose checkout to release the port.
3. Install the native binary and configure its user service as above.
4. Optionally migrate the backed-up container home's `.px0` directory into the
   native user's home, while px0 is stopped. Back up any existing native state
   first and review paths and credentials before copying.
5. Start the service and verify the LAN URL and host terminal tools.

The Docker volume is not automatically used by the native process. Repository
files remain the same when both deployments use the same host directory.

### Native to Docker

Save work, back up native state, and stop and disable the native service:

```bash
systemctl --user disable --now px0.service
cd /mnt/nvme1/Projects/px0
docker compose up -d --build --force-recreate --wait
```

Disabling the native service prevents it from reclaiming the port on reboot.
Migrate `.px0` separately if needed; the container's home is a named volume.
After switching, terminal commands run inside the Docker image again. Do not
disable lingering globally just to stop px0 if other user services need it.

## 11. Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Address already in use | Inspect `ss` and `docker ps`; stop the deployment being replaced or choose another port. |
| Cannot assign requested address | Verify the IP exists on the host; correct `-host` and restart. |
| Works until logout or reboot | Check `loginctl show-user "$USER" -p Linger`, unit enablement, and availability of repositories at boot. |
| `203/EXEC` in service status | Check the installed binary path, executable permissions, architecture, and `ExecStart`. |
| `200/CHDIR` in service status | Check that `WorkingDirectory` exists and is accessible to the user. |
| Tool works in SSH but not px0 | Compare the service `PATH`, shell initialization, and credential/session environment. |
| Terminal says it is disabled | Confirm the unit has `-terminal`, then reload the unit and restart; check for `-no-terminal`. |
| New build has no visible effect | Confirm the service's binary path, rebuild frontend assets, install the binary, restart, and refresh the browser. |
| User systemd bus unavailable | Run as the deployment user in a normal login session; avoid `sudo systemctl --user`. |

Useful diagnostic commands:

```bash
systemctl --user cat px0.service
systemctl --user status px0.service --no-pager
journalctl --user -u px0.service -n 100 --no-pager
journalctl --user -u px0.service -f
```

`systemctl --user stop px0.service` stops the application now.
`systemctl --user disable --now px0.service` also prevents automatic startup.
Neither command deletes the binary, repositories, or saved settings.
