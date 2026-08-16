-- Opt-in for the Ladder Challenge's daily rung email.
--
-- Separate column rather than reusing notify_potd_email: the ladder is a
-- different bet shape from the Play of the Day (it compounds the whole
-- bankroll on each rung rather than flat-staking a unit), so someone can
-- reasonably want one and not the other. Same DEFAULT 0 as every other
-- notification column — opt-in, never opt-out, and never on by default for
-- an account that predates the feature.
ALTER TABLE users ADD COLUMN notify_ladder_email INTEGER DEFAULT 0;
