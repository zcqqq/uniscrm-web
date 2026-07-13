# Vendored wheels

`pyiceberg[pyarrow,...]==0.10.0` requires `pyarrow>=17.0.0` (unpinned upper
bound), which resolves to the latest release at build time. Its wheel is
~48MB and reliably stalls when downloaded by pip from inside the local
Docker/OrbStack builder VM, even though the same URL downloads in seconds
from the host — so it's vendored here and `pip install`ed from disk instead.

To re-vendor after a version bump (target: Cloudflare Containers run
`linux/amd64`, Python 3.12):

```bash
curl -s https://pypi.org/pypi/pyarrow/<version>/json | python3 -c "
import json,sys
d=json.load(sys.stdin)
for u in d['urls']:
    if 'manylinux_2_28_x86_64' in u['filename'] and 'cp312' in u['filename']:
        print(u['url'])
"
# then curl -LO that URL into this directory, and update the Dockerfile's
# COPY/pip install lines to match the new filename.
```
