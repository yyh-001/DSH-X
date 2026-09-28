# 测试用的素材

`localhost-tls.pem`：自签的 `localhost` 证书（cert + key 在同一个文件里），只给
`test/proxy.test.mjs` 当本地 https 源站用——代理那条路（CONNECT 隧道）必须真握手一次才算验过，
而测试又不能依赖外网。里面没有任何真实身份，证书过期了照下面重新生成即可：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/k.pem -out /tmp/c.pem -days 3650 \
  -subj "//CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
cat /tmp/k.pem /tmp/c.pem > localhost-tls.pem
```

（`-subj "//CN=..."` 里两个斜杠是 Git Bash 转 MSYS 路径用的；Linux 上写 `/CN=localhost`。）
测试进程里会设 `NODE_TLS_REJECT_UNAUTHORIZED=0`——自签证书不这么连不上，而这个进程只碰本机回路。
