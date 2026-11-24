#!/bin/sh
# Utopinn 容器入口(简化版 Luker docker-entrypoint):
#   1. 首启把 default/config.yaml 播种进 /data,并翻成容器友好默认
#   2. /data 属主不匹配时修正(挂载卷常为宿主机 uid 或 root)
#   3. 以 node 身份 exec "$@"(已是非 root 运行则直接 exec)
set -e

APP=/app/apps/server
DATA=/data

# --- 首启播种 config.yaml ---
# 四处覆盖,均为"仅首启"的一次性默认,之后由运维在卷内自由改:
#   dataRoot: /data          —— recover.js 等工具从 config 读 dataRoot(--dataRoot 可覆盖),
#                              写绝对路径让它们和 server 看到同一个数据根
#   enableUserAccounts: true —— 内核反裸奔闸刀(verifySecuritySettings)在 listen+零防护
#                              下直接 process.exit(1);账号体系是最小防护面。且闸刀放行后,
#                              所有无密码账号(首启即 default-user)自动配随机密码打到
#                              stderr —— `docker logs` 里拿首次登录凭据
#   whitelistMode: false     —— 出厂 true + 白名单仅回环;容器里 socket IP 是桥接网关,
#                              老 dockerd 解不出 gateway.docker.internal 时首启即 403。
#                              反代部署的 IP 白名单正确位置在边缘(Caddy ACL/cloudflared),
#                              要开应用层白名单的读 README「反代 × whitelistMode」再翻回来
#   browserLaunch.enabled: false —— 容器里没有浏览器可拉
if [ ! -f "$DATA/config.yaml" ] && [ -f "$APP/default/config.yaml" ]; then
    sed \
        -e 's|^dataRoot: ./data$|dataRoot: /data|' \
        -e 's/^enableUserAccounts: false$/enableUserAccounts: true/' \
        -e 's/^whitelistMode: true$/whitelistMode: false/' \
        -e '/^browserLaunch:/,/^[a-zA-Z]/ s/^  enabled: true$/  enabled: false/' \
        "$APP/default/config.yaml" > "$DATA/.config.yaml.tmp"
    mv "$DATA/.config.yaml.tmp" "$DATA/config.yaml"
    # 卷已 node 属主时下方 chown -R 会整体跳过,种子文件得自己归属 node——
    # 否则 server-init 补缺失键/recover.js 都写不动它
    if [ "$(id -u)" = "0" ]; then
        chown node:node "$DATA/config.yaml" || echo "[entrypoint] warning: chown config.yaml failed" >&2
    fi
    echo "[entrypoint] seeded $DATA/config.yaml (docker defaults: dataRoot=/data, accounts on, whitelistMode=false, browserLaunch off)"
fi

# --- /data 属主:只在不匹配时 chown(首启空目录秒过;重开已是 node 直接跳) ---
NODE_UID=$(id -u node)
NODE_GID=$(id -g node)
if [ "$(stat -c '%u:%g' "$DATA")" != "$NODE_UID:$NODE_GID" ] && [ "$(id -u)" = "0" ]; then
    echo "[entrypoint] chown -R node:node $DATA"
    chown -R node:node "$DATA" || echo "[entrypoint] warning: chown $DATA failed" >&2
fi
# 卷内已有非 node 文件(历史权限迁移)的情况:顶层属主对但里面有杂属主 —— 留给运维,
# 不每次启动递归扫整个数据卷。

# --- 降权 exec ---
if [ "$(id -u)" = "0" ]; then
    if command -v setpriv >/dev/null 2>&1; then
        exec setpriv --reuid "$NODE_UID" --regid "$NODE_GID" --init-groups "$@"
    elif command -v runuser >/dev/null 2>&1; then
        exec runuser -u node -- "$@"
    fi
    echo "[entrypoint] warning: no setpriv/runuser available, running as root" >&2
fi

exec "$@"
