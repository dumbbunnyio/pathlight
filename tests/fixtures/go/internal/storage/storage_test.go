package storage

import (
	"testing"

	"example.com/shop/internal/format"
)

func TestNew(t *testing.T) { _ = format.Price(New()) }
