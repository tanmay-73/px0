# Deploy px0 with Docker on a Linux machine

For host shell access and a systemd user service, see the
[native deployment guide](native-deployment.md), including steps to switch
between Docker and native deployment.

This guide deploys the repository's Docker image with Docker Compose. The
browser opens a workbench that lists repositories, opens projects, edits files,
runs Git operations, and provides an integrated terminal.

The examples use the current machine's Ethernet address, `10.20.7.180`, port
`7777`, and repositories under `/mnt/nvme1/Projects`. Replace these values when
deploying on another machine. Run commands on the deployment machine unless a
step explicitly says to use another device.

## 1. Understand what will run

| Component | Configuration |
| --- | --- |
| Image / container | `px0:local` / `px0` |
| Browser address | `http://10.20.7.180:7777` |
| Container listener | `0.0.0.0:7777` inside Docker |
| Host port binding | `10.20.7.180:7777` |
| Repository directory | `PX0_REPOS`, default `/mnt/nvme1/Projects` |
| Runtime user | `px0`, UID/GID `1000:1000` |
| Persistent home | Compose volume `px0-home`, mounted at `/home/px0` |
| Git identity | Host `~/.gitconfig`, mounted read-only |
| Terminal | Enabled by `-terminal` in `compose.yaml` |
| Restart policy | `unless-stopped` |
| Health endpoint | `/api/wb/ping` |

The Dockerfile builds the frontend with Bun and the backend with Go. The final
Alpine image contains px0, Git, Bash, and CA certificates. You do not need Go,
Node.js, or Bun installed on the host to build this image.

Files edited through px0 are written directly to the mounted host repositories.
Settings and workbench history live separately in the persistent home volume.
There is no database to deploy.

Anyone who can reach this deployment can use its editor and enabled terminal.
The terminal runs inside the container and can modify the mounted repositories.
Use a trusted LAN or private VPN; for access across an untrusted network, put
authentication and TLS in front of the service. `-roots` restricts workbench
browsing and opening directories; it does not confine shell commands.

## 2. Prepare the machine

Use a Linux machine with Docker Engine, the Docker Compose plugin, Git, curl,
internet access for the initial build, and enough free disk space for build
images and your repositories. The commands below assume Bash and a regular
deployment user who owns the repositories.

### Install Docker

If Docker already works, skip installation. Otherwise, follow Docker's
[installation instructions for your distribution](https://docs.docker.com/engine/install/).
For Ubuntu, the following uses Docker's official package repository; review
the [Ubuntu prerequisites](https://docs.docker.com/engine/install/ubuntu/)
first, particularly if another container runtime is already installed.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

The remaining examples run Docker as the deployment user. If your machine
permits Docker group access, add that user and then log out and back in:

```bash
sudo usermod -aG docker "$USER"
```

Membership grants administrative control through Docker. Alternatively, use
`sudo` for Docker commands, but resolve the `.gitconfig` bind mount to your
deployment user's absolute path first so it does not resolve to `/root`.

Verify access after logging back in:

```bash
docker version
docker compose version
docker info
```

### Check Ethernet and reserve an address

```bash
ip -brief address
ip route
```

On the current machine, `eno1` has `10.20.7.180/24`. Another machine may use an
interface such as `enp3s0` and a different address. Use its actual LAN IPv4
address in Compose. Reserve that address through DHCP or your normal static-IP
configuration so it does not change after reboot. Do not assign `10.20.7.180`
to a second machine while the current machine is using it.

### Check for a port conflict

```bash
sudo ss -ltnp 'sport = :7777'
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
```

If a native px0 service already owns this port, inspect it:

```bash
systemctl --user status px0.service --no-pager
```

When replacing that native deployment with Docker, stop and disable it:

```bash
systemctl --user disable --now px0.service
```

Stopping the native service also ends its workspace processes and terminals.
If the port belongs to a different application, choose another host port in
Compose instead of stopping an unrelated service.

## 3. Obtain the application and repositories

On this machine the application is already at `/mnt/nvme1/Projects/px0`:

```bash
cd /mnt/nvme1/Projects/px0
```

On another machine, copy this checkout, including its Dockerfile and
`compose.yaml`, or clone the repository and check out the revision containing
the changes you intend to deploy:

```bash
mkdir -p "$HOME/Projects"
git clone https://github.com/px0-ai/px0.git "$HOME/Projects/px0"
cd "$HOME/Projects/px0"
git status --short
```

Cloning upstream will not include local, uncommitted changes from another
machine. Transfer those changes explicitly if they are part of your deployment.
Keep your other repositories beneath the parent directory you plan to mount.

## 4. Configure Compose for the target machine

All subsequent `docker compose` commands should run from the checkout directory.

### Set the repository directory

Create or edit `.env` beside `compose.yaml`. For another machine, for example:

```dotenv
PX0_REPOS=/home/alex/Projects
```

Use an existing absolute path. The repository mount and container working
directory both use this value, keeping paths the same inside and outside Docker.
On the current machine, the default `/mnt/nvme1/Projects` already works, so
`.env` is optional. Do not overwrite an existing `.env` containing other settings.

### Set the address and port

Edit this entry in `compose.yaml` to match the target machine:

```yaml
ports:
  - "10.20.7.180:7777:7777"
```

The three values mean `HOST_IP:HOST_PORT:CONTAINER_PORT`. For example, on a
machine with address `192.168.1.50`, use `192.168.1.50:7777:7777` and visit
`http://192.168.1.50:7777`. To use host port `7780`, use
`192.168.1.50:7780:7777`; keep the internal health check on port `7777`.

The internal listener must remain `0.0.0.0` so Docker can forward traffic to it.
The host address belongs in `ports`, not in the container's `-host` flag.

### Prepare Git identity

The supplied Compose file mounts `${HOME}/.gitconfig`. Check that it is a file:

```bash
test -f "$HOME/.gitconfig"
git config --global user.name
git config --global user.email
```

If it is missing, configure your identity:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

If Git commits are unnecessary, remove the `.gitconfig` mount instead. A missing
bind-mount source can become a directory and cause confusing startup or Git
errors. Host credential helpers and included configuration files also need
their corresponding tools/files inside the container to work.

### Check file ownership

```bash
id
ls -ld /path/to/your/repositories
```

The image uses UID/GID `1000:1000`. If your repository owner uses different IDs,
change the `adduser` command in the Dockerfile to create that UID and a matching
group, then rebuild. Ensure existing persistent-home files are writable by the
new IDs as well. Avoid changing ownership across all repositories just to fit
the container; match the container identity to the deployment user.

### Choose terminal behavior

The supplied command enables the terminal and limits workbench browsing to the
configured directory:

```yaml
command: ["-terminal", "-roots", "${PX0_REPOS:-/mnt/nvme1/Projects}"]
```

Remove `-terminal` to disable shell access while retaining the workbench. The
container includes Bash and Git, but it does not inherit host tools such as
Node, Go, Python, or coding agents. Add needed tools to a custom image and
rebuild, or use a native deployment when host tools and host shell access are
required. A root restriction is not a shell sandbox.

### Review the resolved configuration

```bash
docker compose config
docker compose config --quiet
```

Check the resolved repository path, Git configuration source, LAN address,
terminal flag, and `/home/px0` volume before starting.

## 5. Build and start

```bash
docker compose up -d --build --wait
```

This builds the image, starts the container in the background, and waits for
the workbench health check. The first build downloads base images and build
dependencies; later builds reuse unchanged layers. A successful command ends
with the container healthy.

Inspect status and logs:

```bash
docker compose ps
docker compose logs --tail 50 px0
docker inspect px0 --format 'Health={{.State.Health.Status}} Ports={{json .NetworkSettings.Ports}}'
```

The port mapping should contain `10.20.7.180` and `7777` for the current machine.
The log may show a Docker bridge address as its network URL; use the published
host LAN address in your browser.

## 6. Verify from the host and another device

On the Docker host:

```bash
curl --noproxy '*' --max-time 10 --fail http://10.20.7.180:7777/api/wb/ping
curl --noproxy '*' --max-time 10 --fail -o /dev/null -w 'HTTP %{http_code}\n' http://10.20.7.180:7777/
```

The ping response should include `"workbench":true`, and the homepage should
return HTTP `200`. Then open `http://10.20.7.180:7777` on a second device on the
LAN. A successful request from the Docker host alone does not verify the entire
network path from another device.

Open a repository, check its files, and open the integrated terminal. For a
non-destructive terminal check, run:

```bash
pwd
id
git --version
```

### Network and firewall considerations

Allow the intended clients to reach TCP port `7777` in your network policy.
Check VLAN boundaries, Wi-Fi client isolation, routing, and VPN/proxy settings
if another device cannot connect.

Docker manages forwarding rules for published ports. Do not assume a normal
UFW rule blocks a published container port: Docker traffic can bypass those
rules. Follow Docker's
[firewall guidance](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
for your firewall backend. Binding a specific host IP selects the destination
address; it does not authenticate clients or restrict their source subnet.

## 7. Redeploy after changes

Get the intended source changes onto the machine first. If you use Git, inspect
the working tree before updating; preserve local edits. For a clean checkout
tracking a remote branch, an update can use `git pull --ff-only`.

Rebuild and recreate using the current source:

```bash
docker compose up -d --build --force-recreate --wait
docker compose ps
curl --noproxy '*' --max-time 10 --fail http://10.20.7.180:7777/api/wb/ping
```

Recreation ends existing integrated-terminal sessions. Repository files and the
persistent home volume remain. `docker compose restart` alone does not rebuild
the image or apply changed Compose settings. Refresh the browser after updating.

For a configuration-only change, reuse the existing image:

```bash
docker compose up -d --no-build --force-recreate --wait
```

## 8. Routine operations

| Task | Command |
| --- | --- |
| Show health and ports | `docker compose ps` |
| Follow logs | `docker compose logs -f --tail 100 px0` |
| Open an administrative shell in the container | `docker compose exec px0 bash` |
| Stop while keeping the container | `docker compose stop` |
| Start a stopped container | `docker compose start` |
| Remove the deployment containers/network, keep settings | `docker compose down` |
| Recreate after removal | `docker compose up -d --wait` |

The `unless-stopped` policy restarts the container after a crash or daemon
restart, provided it was not explicitly stopped. Enable Docker at boot as shown
above. An unhealthy status is diagnostic; the policy does not itself restart a
process that remains running but unhealthy.

## 9. Back up and restore

Back up both the repositories and px0's persistent home. Image backups do not
contain bind-mounted repositories or named-volume contents. Git remotes do not
preserve uncommitted or untracked files.

To make a consistent copy of the container home, run from the checkout:

```bash
PX0_BACKUP_DIR="$HOME/px0-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$PX0_BACKUP_DIR/home"
docker compose stop
docker cp px0:/home/px0/. "$PX0_BACKUP_DIR/home/"
docker compose start
```

Use a fresh backup directory for each snapshot to avoid mixing old and new
files. Keep backups outside the checkout so they are not sent to Docker as build
context. Copy the backup off the machine and protect it as private data: settings
can contain access tokens. Back up your repository directory separately using
your normal file-backup process. Do not commit backups into Git.

To restore on a new machine, first configure Compose and restore repositories
to the configured host directory. Use the same image UID/GID as the source
deployment. Set `PX0_BACKUP_DIR` to the transferred snapshot's absolute path,
then run:

```bash
docker compose build
docker compose create
docker cp "$PX0_BACKUP_DIR/home/." px0:/home/px0/
docker run --rm --user 0 --volumes-from px0 alpine:3.21 chown -R 1000:1000 /home/px0
docker compose up -d --wait
```

These restore steps assume a fresh destination home volume. Back up an existing
destination before copying into it. If you changed the runtime IDs, use those
IDs in `chown`. Check repository paths and credentials after migration.

Ordinary `docker compose down` keeps the home volume. Adding `--volumes` deletes
it, including settings and workbench state; reserve that option for an
intentional reset with a verified backup.

## 10. Roll back a release

Before an update, retain the current image under a different tag:

```bash
docker image tag px0:local px0:rollback
```

If the new release fails, restore that tag and recreate without building:

```bash
docker image tag px0:rollback px0:local
docker compose up -d --no-build --force-recreate --wait
```

Keep a record of the source revision and local changes associated with each
image. Image rollback does not undo edits to repositories or persistent state.

## 11. Troubleshooting

### Port is already in use

Inspect `sudo ss -ltnp 'sport = :7777'` and `docker ps`. A native `px0.service`
was the cause on this machine. Stop it only when replacing it with Docker, as
described above. After resolving the conflict, recreate the container:

```bash
docker compose up -d --no-build --force-recreate --wait
```

Recreation matters after a failed port bind: a later start can leave you with
an internally healthy container whose published mapping is absent. Confirm
`docker inspect px0 --format '{{json .NetworkSettings.Ports}}'` includes the
expected binding.

### Cannot assign the requested address

The IP in `ports` must already belong to the host. Check `ip -brief address`,
correct the mapping, and recreate. Docker does not assign that LAN IP to the
Ethernet interface for you.

### Terminal says it is disabled

Confirm `-terminal` is present in the resolved command:

```bash
docker inspect px0 --format '{{json .Config.Cmd}}'
```

Apply Compose changes by recreating, then refresh or reopen the workspace.
Check that `-no-terminal` has not also been added.

### Terminal lacks host commands

This is expected for tools absent from the runtime image. Install them in a
custom Dockerfile and rebuild for a lasting change. Installing interactively
inside a running container is lost on recreation. Host tools are available
through a native deployment instead; run only one deployment on the same port.

### Permission denied when saving files or settings

```bash
docker compose exec px0 id
docker compose exec px0 sh -c 'test -w "$HOME" && echo "Home writable"'
ls -ld /path/to/your/repositories
```

Compare container IDs with repository ownership. Check the particular project
directory as well as its parent. Correct the runtime identity or targeted file
permissions; do not run the whole application as root to hide the mismatch.

### Git commits work but pushes fail

Git identity is not authentication. The default image does not contain your
host's SSH keys, credential-helper programs, or GitHub CLI login. Configure a
credential method supported inside the container. The Compose file includes
an optional read-only `.git-credentials` mount for HTTPS credential-store
setups; enable it only when deliberately granting that account's access to
this deployment. Confirm its source file exists first.

### Build fails while downloading dependencies

Check registry/package-host access, DNS, proxy configuration, and disk space:

```bash
docker system df
docker compose --progress plain build
```

Diagnose the actual failing download before deleting caches. The Dockerfile
bundles the frontend itself; a separate
host-side frontend build is unnecessary.

### Container is unhealthy or stops immediately

```bash
docker compose logs --tail 100 px0
docker inspect px0 --format '{{json .State.Health}}'
```

Check for a nonexistent `PX0_REPOS`, a Git configuration mount that points to a
directory, an invalid command-line flag, or an unavailable port. The supplied
health endpoint is for workbench mode. If you change the command to open a
single directory directly, update the health check to `/api/meta`.

## Reference files

- [Dockerfile](../Dockerfile): build stages, bundled tools, runtime identity.
- [compose.yaml](../compose.yaml): mounts, port binding, command, health check.
- [Remote workspaces](features/remote-workspaces.md): remote usage and flags.
- [Integrated terminal](features/terminal.md): terminal behavior and settings.
