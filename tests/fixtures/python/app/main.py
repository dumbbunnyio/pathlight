import importlib
import json

import requests
import shop
from shop import Order, Item, catalog, VERSION, ghost
from shop.missing import nothing
from .. import above

rules = importlib.import_module("shop.pricing.rules")
