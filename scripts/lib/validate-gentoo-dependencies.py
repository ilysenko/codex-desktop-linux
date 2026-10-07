"""Validate feature atoms with the host's actual EAPI 8 Portage parser."""

import json
import sys
from portage.dep import Atom


def validate(plan):
    for atoms in plan["dependencies"].values():
        for atom in atoms:
            Atom(atom, eapi="8", allow_repo=False)


if __name__ == "__main__":
    validate(json.load(sys.stdin))
