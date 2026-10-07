# Instance Fluxer / Myserycord — fluxer.lbxmb.fr

CT Proxmox **104** `fluxxer` (Debian 13, LXC non privilégié, `nesting=1,keyctl=1`).
Stack dans `/root/fluxer`, installée le 2026-10-07 avec :

```sh
sh install.sh --domain fluxer.lbxmb.fr --tls proxy --edge-bind 192.168.1.50:8080 --no-start --allow-root
```

Les fichiers de ce dossier sont la copie versionnée de ce qui est déployé sur l'hôte.

## Schéma réseau

```
Internet ──HTTPS──> Cloudflare ──tunnel──> CT cloudflared 192.168.1.101
                                                │ http://192.168.1.50:8080
                                                ▼
              eth0 (vmbr0) 192.168.1.50/24, gw 192.168.1.1   ← route par défaut, 24h/24
              ┌───────────────── fluxxer ─────────────────┐
              │ edge (Caddy) :8080 → api, gateway, media, │
              │ admin, app-proxy, /livekit/* (signaling)  │
              │ livekit : 7881/tcp, 7882/udp              │
              └───────────────────────────────────────────┘
              eth1 (vmbr1) 151.240.100.29/24, gw 151.240.100.1 ← IP publique, média WebRTC seul
Internet ──WebRTC 7881/tcp 7882/udp──> 151.240.100.29 (pas de NAT, pas de règle Mikrotik)
```

- Rien n'écoute sur 80/443. L'edge écoute seulement sur `192.168.1.50:8080`.
- `eth1` peut tomber : le web et le texte passent par `eth0` et continuent ; seul le vocal coupe.

## Fichiers modifiés

| Fichier | Changement |
|---|---|
| `/root/fluxer/.env` | généré par l'installeur, plus : `FLUXER_EDGE_TRUSTED_PROXIES=192.168.1.101/32`, `FLUXER_LIVEKIT_USE_EXTERNAL_IP=false`, `FLUXER_LIVEKIT_NODE_IP=151.240.100.29` |
| `/root/fluxer/Caddyfile` | bloc `myserycord-begin/end` : IP Cloudflare + routes des badges (voir plus bas). Original : `Caddyfile.orig` |
| `/root/fluxer/.env` `COMPOSE_FILE` | `:myserycord.compose.yml` ajouté (service `myserycord`) |
| `/root/fluxer/myserycord/` | copie de `deploy/myserycord/badges/` + `Caddyfile.snippet` + `myserycord.compose.yml` |
| `/usr/local/sbin/fluxer-myserycord-patch` | réapplique le bloc Caddyfile, `COMPOSE_FILE` et démarre `myserycord` (idempotent) |
| `/etc/nftables.conf` | réécrit (`host/nftables.conf`). Original : `/etc/nftables.conf.orig-fluxer` |
| `/etc/iproute2/rt_tables.d/eth1rt.conf` | `100 eth1rt` |
| `/usr/local/sbin/fluxer-eth1-routing` | policy routing eth1 (idempotent) |
| `/usr/local/sbin/fluxer-eth1-watch` | watchdog eth1 + LiveKit |
| `/etc/systemd/system/fluxer-eth1-watch.{service,timer}` | watchdog toutes les minutes |
| `/etc/network/if-up.d/fluxer-eth1` | hook ifupdown2 à la remontée d'eth1 |

Paquets ajoutés : `docker-ce` (dépôt officiel Docker), `docker-compose-plugin`, `curl`, `tcpdump`, `conntrack`.

## Pare-feu (nftables, table `inet fluxer_host`)

- **input** : sur `eth1`, tout est refusé sauf ICMP/ICMPv6, `7881/tcp`, `7882/udp` et le trafic établi. SSH n'est plus joignable par l'IP publique. 7881/7882 sont refusés sur les autres interfaces.
- **forward** (priorité -10, équivalent de `DOCKER-USER`, ne dépend pas de l'ordre de démarrage de Docker) :
  - `192.168.1.50:8080` n'accepte que `192.168.1.101` (le CT cloudflared). Sinon, un hôte du LAN pourrait usurper l'IP d'un client.
  - les ports publiés 7881/7882 ne sont acceptés qu'en entrée sur `eth1`.
  - les règles ne visent que `ct direction original`. Sans ça, les réponses des conteneurs sont bloquées.
- **eth1mark** (prerouting) : les connexions entrées par `eth1` reçoivent le connmark `0x1`. Leurs réponses venant des conteneurs reçoivent la marque `0x1`.
- Pas de `flush ruleset` dans `/etc/nftables.conf` : un `systemctl reload nftables` garde les règles Docker.

## Routage (policy routing)

```
ip rule  100: from 151.240.100.29 lookup eth1rt
ip rule  101: from all fwmark 0x1 lookup eth1rt
table eth1rt: default via 151.240.100.1 dev eth1
```

La règle `fwmark` est indispensable. LiveKit tourne en bridge Docker, donc ses réponses partent d'une IP `172.x`. Le de-NAT vers `151.240.100.29` n'a lieu qu'après la décision de routage, donc `from 151.240.100.29` ne suffit pas. La route par défaut principale reste sur `eth0`.

## Hook et watchdog eth1

`eth1` est une veth LXC : une coupure en amont de `vmbr1` ne la fait pas passer à down. Le timer `fluxer-eth1-watch` tourne chaque minute. Il :
1. réapplique le policy routing ;
2. teste `ping -I eth1 151.240.100.1` ;
3. écrit `up|down livekit=<état> <date>` dans `/run/fluxer-eth1.status` ;
4. logge les changements (`journalctl -t fluxer-eth1`) ;
5. recrée LiveKit au passage down → up.

Le hook `/etc/network/if-up.d/fluxer-eth1` fait la même chose sur un `ifup eth1`.
Testé le 2026-10-07 : avec `ip link set eth1 down`, le web répondait toujours 200. Avec `ip link set eth1 up`, LiveKit a été recréé en moins d'une minute. Il faut rejoindre de nouveau le salon vocal.

Uptime Kuma : utiliser un moniteur TCP sur `151.240.100.29:7881`, ou lire `/run/fluxer-eth1.status`.

## IP client et Cloudflare

L'API prend l'IP **la plus à gauche** de `X-Forwarded-For` (`packages/ip_utils/src/ClientIp.ts`). Cloudflare *ajoute* la vraie IP à la suite de celle envoyée par le visiteur, et refuse qu'une Transform Rule réécrive ce header. Le Caddyfile le remplace donc par `CF-Connecting-IP` :

```caddy
@cf header CF-Connecting-IP *
request_header @cf X-Forwarded-For {http.request.header.CF-Connecting-IP}
```

Ne **pas** utiliser `FLUXER_CLIENT_IP_HEADER_NAME=cf-connecting-ip` : les appels internes (app-proxy → edge:8088) n'ont pas ce header et prennent un 403, donc le site renvoie 503 (testé).

**`sh install.sh --update` rafraîchit le Caddyfile.** Après une mise à jour, lancer `fluxer-myserycord-patch` (l'auto-update le fait).

## Badges personnalisés

Les images restent les images officielles. Un petit service à côté, `myserycord` (`python:3.13-alpine`, stdlib seule, code dans `badges/`), ajoute les badges :

- **Admin** : panel admin → *Badges* (lien ajouté sous *Users*), ou directement `https://fluxer.lbxmb.fr/admin/myserycord/`. On y crée un badge (nom, description, image PNG/WebP/GIF/SVG ≤ 256 Ko), puis on cherche un utilisateur (pseudo, ID ou e-mail) pour le lui attribuer. Accès : session du panel admin officiel avec l'ACL `user:update:flags` (ou `*`). Chaque modification est loggée (`docker compose logs myserycord`).
- **Web / PWA** : Caddy fait passer les pages HTML de l'app par `myserycord`, qui ajoute `<script src="/myserycord/badges.js">`. Le script trouve les composants de badges du client officiel (prop `data-flx` en `…user-profile-badges`) et y ajoute les images.
- **Desktop** : il embarque l'app du fork, qui lit `/myserycord/badges.json` nativement (`fluxer_app/src/features/user/state/CustomBadges.ts`).
- **Données** : volume `fluxer_myserycord-data` (`badges.json` + `icons/`). À sauvegarder avec le reste.
- **Si `myserycord` tombe** : Caddy repasse directement sur `app-proxy` / `admin` (`lb_policy first`). Le site marche, sans les badges.
- **Si une mise à jour Fluxer renomme les `data-flx`** : les badges disparaissent du web sans rien casser. Adapter `badges.js`.

Mettre à jour le service après un changement dans le repo :

```sh
scp deploy/myserycord/badges/* deploy/myserycord/Caddyfile.snippet deploy/myserycord/myserycord.compose.yml root@192.168.1.50:/root/fluxer/myserycord/
ssh root@192.168.1.50 'cd /root/fluxer && docker compose restart myserycord'
```

## Cloudflare

- Tunnel (CT 192.168.1.101) : `fluxer.lbxmb.fr` → `http://192.168.1.50:8080`, `connectTimeout: 30s`.
- Plan Free : requêtes limitées à 100 Mo. Régler `max_attachment_file_size` en dessous (par exemple 95 Mo) dans l'admin.

## Vérifications

```sh
cd /root/fluxer && docker compose ps      # tout healthy, seaweedfs-init Exited (0)
base=https://fluxer.lbxmb.fr
for p in /_health /api/_health /gateway/_health /media/_health /.well-known/fluxer /; do
  printf '%s %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' "$base$p")" "$p"; done
curl -sS -i --http1.1 --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==' \
  "$base/gateway?v=1&encoding=json" | head -1   # HTTP/1.1 101 Switching Protocols
```

## Sauvegardes

À garder hors du CT : `/root/fluxer/.env` (tous les secrets), le dump de la base, les volumes `fluxer_seaweedfs-data` et `fluxer_myserycord-data` (badges).

```sh
cd /root/fluxer && mkdir -p backups
# Base, à chaud
docker compose exec -T postgres sh -c \
  'pg_dump -U $POSTGRES_USER -d $POSTGRES_DB --format=custom' \
  > "backups/fluxer-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Uploads, avec arrêt
docker compose stop
docker run --rm -v fluxer_seaweedfs-data:/data -v "$PWD/backups:/backup" \
  alpine:3.22 tar czf /backup/seaweedfs-data.tgz -C /data .
docker compose up -d
```

## Mise à jour

**Automatique** : le timer `fluxer-auto-update.timer` lance `/usr/local/sbin/fluxer-auto-update` chaque lundi vers 4h30 UTC (`Persistent=true`, donc rattrapé au démarrage s'il a été manqué). Le script :
1. télécharge `install.sh` et vérifie sa somme sha256 ;
2. lance `install.sh --update`, qui sauvegarde la base, les uploads et `.env` (prévoir quelques minutes d'arrêt), puis pull, recrée et vérifie ;
3. lance `fluxer-myserycord-patch` : bloc Caddyfile (IP Cloudflare + badges), `COMPOSE_FILE`, service `myserycord` ;
4. contrôle `/_health`.

Logs : `journalctl -u fluxer-auto-update`. Lancer à la main : `systemctl start fluxer-auto-update`. Revenir en arrière : `sh /root/fluxer-install/install.sh --rollback --allow-root`.

**Manuelle** :

```sh
cd /root/fluxer && sh install.sh --update --allow-root
fluxer-myserycord-patch
```

## Tout annuler

```sh
cd /root/fluxer && docker compose down          # garde les volumes
# docker compose down -v                         # DÉTRUIT base et uploads
systemctl disable --now fluxer-eth1-watch.timer
rm /etc/systemd/system/fluxer-eth1-watch.* /usr/local/sbin/fluxer-eth1-* \
   /etc/network/if-up.d/fluxer-eth1 /etc/iproute2/rt_tables.d/eth1rt.conf
systemctl daemon-reload
ip rule del priority 100; ip rule del priority 101; ip route flush table 100
cp /etc/nftables.conf.orig-fluxer /etc/nftables.conf && nft delete table inet fluxer_host && nft -f /etc/nftables.conf
# ⚠ cela rouvre tout sur l'IP publique d'eth1, SSH compris
```

Supprimer aussi la route du tunnel côté cloudflared.
