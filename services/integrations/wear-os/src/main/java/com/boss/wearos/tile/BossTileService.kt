package com.boss.wearos.tile

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.Button
import androidx.wear.compose.foundation.lazy.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.ui.tooling.preview.WearPreviewDevices
import androidx.wear.compose.ui.tooling.preview.WearPreviewFontScales
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.wear.tiles.RequestBuilders.ResourcesRequest
import androidx.wear.tiles.RequestBuilders.TileRequest
import androidx.wear.tiles.ResourceBuilders.Resources
import androidx.wear.tiles.TileBuilders.Tile
import androidx.wear.tiles.material.Button.Builder
import androidx.wear.tiles.material.Chip
import androidx.wear.tiles.material.ChipColors
import androidx.wear.tiles.material.LayoutElementBuilders
import androidx.wear.tiles.material.LayoutElementBuilders.Column.Builder
import androidx.wear.tiles.material.LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER
import androidx.wear.tiles.material.LayoutElementBuilders.Layout
import androidx.wear.tiles.material.LayoutElementBuilders.Row
import androidx.wear.tiles.material.LayoutElementBuilders.Spacer
import androidx.wear.tiles.material.Text.Builder as TextBuilder
import androidx.wear.tiles.material.Typography
import androidx.wear.tiles.render.SingleTileLayoutRenderer
import androidx.wear.tiles.render.TileLayoutRenderer
import androidx.wear.tooling.preview.devices.WearDeviceDefinitions
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch

/**
 * Tile service for the IR Custom AIOS Wear OS integration.
 */
class IR Custom AIOSTileService : androidx.wear.tiles.TileService() {
    
    override fun onTileRequest(requestParams: TileRequest): ListenableFuture<Tile> {
        val deviceState = requestParams.currentState.deviceConfiguration
        
        val layout = LayoutElementBuilders.Column.Builder()
            .setHorizontalAlignment(HORIZONTAL_ALIGN_CENTER)
            .setWidth(LayoutElementBuilders.WRAP_CONTENT)
            .setHeight(LayoutElementBuilders.WRAP_CONTENT)
            
        // Title
        layout.addContent(
            TextBuilder()
                .setText("IR Custom AIOS")
                .setTypography(Typography.TITLE3)
                .build()
        )
        
        // Last response placeholder
        layout.addContent(
            TextBuilder()
                .setText("Last response: Loading...")
                .setTypography(Typography.CAPTION1)
                .build()
        )
        
        // Spacer
        layout.addContent(Spacer.Builder().setHeight(dp(8)).build())
        
        // Action buttons
        val row = Row.Builder()
            .setWidth(LayoutElementBuilders.MATCH_PARENT)
            .setHeight(LayoutElementBuilders.WRAP_CONTENT)
            .setHorizontalAlignment(HORIZONTAL_ALIGN_CENTER)
            
        // Brief Me button
        row.addContent(
            Chip.Builder()
                .setChipColors(ChipColors.primaryChipColors())
                .setContentDescription("Brief Me")
                .setOnClick(
                    androidx.wear.tiles.ActionBuilders.LoadAction.Builder()
                        .setUri(android.net.Uri.parse("boss://brief"))
                        .build()
                )
                .setLabel("Brief Me")
                .build()
        )
        
        // Spacer
        row.addContent(Spacer.Builder().setWidth(dp(8)).build())
        
        // Check Email button
        row.addContent(
            Chip.Builder()
                .setChipColors(ChipColors.primaryChipColors())
                .setContentDescription("Check Email")
                .setOnClick(
                    androidx.wear.tiles.ActionBuilders.LoadAction.Builder()
                        .setUri(android.net.Uri.parse("boss://email"))
                        .build()
                )
                .setLabel("Check Email")
                .build()
        )
        
        layout.addContent(row.build())
        
        // Spacer
        layout.addContent(Spacer.Builder().setHeight(dp(8)).build())
        
        // Project Status button
        layout.addContent(
            Chip.Builder()
                .setChipColors(ChipColors.primaryChipColors())
                .setContentDescription("Project Status")
                .setOnClick(
                    androidx.wear.tiles.ActionBuilders.LoadAction.Builder()
                        .setUri(android.net.Uri.parse("boss://project"))
                        .build()
                )
                .setLabel("Project Status")
                .build()
        )
        
        val layoutElement = layout.build()
        
        return Futures.immediateFuture(
            Tile.Builder()
                .setResourcesVersion("1")
                .setLayout(
                    Layout.Builder()
                        .setRoot(layoutElement)
                        .build()
                )
                .build()
        )
    }

    override fun onResourcesRequest(requestParams: ResourcesRequest): ListenableFuture<Resources> {
        return Futures.immediateFuture(
            Resources.Builder()
                .setVersion("1")
                .build()
        )
    }
}