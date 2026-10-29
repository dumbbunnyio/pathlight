package storage

// Store keeps entries.
type Store struct{ entries []Entry }

func New() *Store { return &Store{} }

func (s *Store) Add(e Entry) { s.entries = append(s.entries, e) }
