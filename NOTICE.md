# Notice

ohmypi-gateway is an independent community project by Jason Crabtree. It is
**not affiliated with, endorsed by, or supported by** the oh-my-pi maintainers.

- [oh-my-pi](https://github.com/can1357/oh-my-pi) is a separate project, MIT
  licensed, and provides the `omp` binary and RPC protocol this gateway talks
  to. Nothing here is a fork of it.
- The name is descriptive: this is a gateway for omp. No upstream logos,
  artwork, or iconography are used.
- The web client in `web/` is original work built for this gateway. The older
  Alpine.js dashboard in `static/` vendors its own dependencies in-tree.
- `tests/e2e.py` and the docs describe the RPC/HTTP contract as observed
  against released omp versions; version-specific behaviour can change when
  upstream changes.

If you are the maintainer of an upstream project and want something here
changed for naming or attribution reasons, open an issue and it will be
handled.
