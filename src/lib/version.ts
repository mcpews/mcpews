export enum Version {
    V0_0_1 = 0x1,
    V0_0_2 = 0x2,
    V0_0_3 = 0x3,
    V0_0_4 = 0x4,
    V1_0_0 = 0x1000000,
    V1_1_0 = 0x1010000,
    V1_2_0 = 0x1020000,
    V1_3_0 = 0x1030000,
    V1_4_0 = 0x1040000
}

export enum MinecraftCommandVersion {
    Initial = 0x1,
    TpRotationClamping = 0x2,
    NewBedrockCmdSystem = 0x3,
    ExecuteUsesVec3 = 0x4,
    CloneFixes = 0x5,
    UpdateAquatic = 0x6,
    EntitySelectorUsesVec3 = 0x7,
    ContainersDontDropItemsAnymore = 0x8,
    FiltersObeyDimensions = 0x9,
    ExecuteAndBlockCommandAndSelfSelectorFixes = 0xa,
    InstantEffectsUseTicks = 0xb,
    DontRegisterBrokenFunctionCommands = 0xc,
    ClearSpawnPointCommand = 0xd,
    CloneAndTeleportRotationFixes = 0xe,
    TeleportDimensionFixes = 0xf,
    CloneUpdateBlockAndTimeFixes = 0x10,
    CloneIntersectFix = 0x11,
    FunctionExecuteOrderAndChestSlotFix = 0x12,
    NonTickingAreasNoLongerConsideredLoaded = 0x13,
    SpreadplayersHazardAndResolvePlayerByNameFix = 0x14,
    NewExecuteCommandSyntaxExperimentAndChestLootTableFixAndTeleportFacingVerticalUnclampedAndLocateBiomeAndFeatureMerged = 0x15,
    WaterloggingAddedToStructureCommand = 0x16,
    SelectorDistanceFilteredAndRelativeRotationFix = 0x17,
    NewSummonCommandAddedRotationOptionsAndBubbleColumnCloneFix = 0x18,
    NewExecuteCommandReleaseEnchantCommandLevelFixAndHasItemDataFixAndCommandDeferral = 0x19,
    ExecuteIfScoreFixes = 0x1a,
    ReplaceItemAndLootReplaceBlockCommandsDoNotPlaceItemsIntoCauldronsFix = 0x1b,
    ChangesToCommandOriginRotation = 0x1c,
    RemoveAuxValueParameterFromBlockCommands = 0x1d,
    VolumeSelectorFixes = 0x1e,
    EnableSummonRotation = 0x1f,
    SummonCommandDefaultRotation = 0x20,
    PositionalDimensionFiltering = 0x21,
    V1_20_0 = 0x22,
    V1_20_10 = 0x23,
    V1_20_30 = 0x24
}
