from __future__ import annotations

import os
from typing import TYPE_CHECKING

from . import catalog
from .pricing.rules import discount
from ..shop.catalog import Item

if TYPE_CHECKING:
    from shop.audit import Auditor


@register
def place(order: Order, auditor: Auditor | None = None) -> Order:
    import shop.audit

    return discount(order)


class Order:
    items: list[Item] = []
