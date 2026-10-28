package main

import (
	"fmt"

	"example.com/other/lib"
	. "example.com/shop/internal/format"
	_ "example.com/shop/internal/format/nested"
	"example.com/shop/internal/render"
	st "example.com/shop/internal/storage"
)

func main() {
	var e st.Entry
	store := st.New()
	store.Add(e)
	fmt.Println(Price(store), lib.X, view.Page{})
}
