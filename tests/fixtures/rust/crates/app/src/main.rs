mod cli;

use shop::{Price, Cart as Basket};
use shop::store::cart;

fn main() {
    shop::inline::helper();
    cli::run();
}
