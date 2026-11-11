use std::collections::HashMap;

use json::Value;
use serde::{Deserialize, Serialize};

use super::super::money::Price;
use crate::money::rates::Rate;

pub struct Cart {
    pub lines: HashMap<String, Value>,
}

pub fn total(rate: Rate) -> Price {
    crate::placed::place()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inline::helper;
}
