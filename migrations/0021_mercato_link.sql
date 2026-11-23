-- Mercato: case simili aggiunte da Mattia con il link di Airbnb (23/11/2026). Restano anche quando si rifà la ricerca.
ALTER TABLE market_comps ADD COLUMN source TEXT NOT NULL DEFAULT 'ricerca' CHECK (source IN ('ricerca', 'manuale'));
