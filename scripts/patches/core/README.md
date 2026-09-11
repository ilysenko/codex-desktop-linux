# Core patch registry

OpenAI's official Linux package is the compatibility baseline. The registry
contains only required compatibility patches for reproduced mandatory failures
in the current signed stable package.

Product extensions and measured workarounds belong in disabled-by-default
`linux-features/<id>/` directories. A new core descriptor is allowed only when
the current signed official package cannot pass a mandatory launch/work smoke
test without it; the descriptor must include the reproduction evidence and a
required regression test in the migration tracking record.

Current required patch:

- `upstream-renderer-cycle` defers the cyclic `authed-route` initializer in
  signed stable `26.908.31748`; remove it when the next signed stable no longer
  has that cycle.
