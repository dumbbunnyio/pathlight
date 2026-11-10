pub mod rates;

/// A price in cents.
#[derive(Clone)]
pub struct Price(u64);

impl Price {
    pub fn add(&self, other: &Price) -> Price {
        Price(self.0 + other.0)
    }
}
