package com.boss.wearos.tile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable

@Composable
fun IR Custom AIOSWearOSTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S -> {
            androidx.core.graphics.drawable.toColorStateList(android.graphics.Color.BLUE) // Placeholder
        }
        darkTheme -> androidx.wear.compose.material.darkColors()
        else -> androidx.wear.compose.material.lightColors()
    }

    androidx.wear.compose.material.MaterialTheme(
        colors = colorScheme,
        typography = androidx.wear.compose.material.Typography(),
        content = content
    )
}