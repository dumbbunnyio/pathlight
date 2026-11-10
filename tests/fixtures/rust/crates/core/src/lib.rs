//! The shop's core: prices, carts and where they are kept.
pub mod store;
mod money;
#[path = "odd/place.rs"]
mod placed;

pub use money::Price;
pub use store::*;

pub mod inline {
    pub fn helper() {}
}

#[cfg(test)]
mod tests;

#[cfg(feature = "extra")]
mod extra;
