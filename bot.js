const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Initialize SQLite database
const db = new sqlite3.Database('party_finder.db');

// Temporary storage for party creation data
const partyCreationSessions = new Map();

function generateSessionId() {
    return Math.random().toString(36).substring(2, 10);
}

// Initialize tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS parties (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        max_members INTEGER NOT NULL,
        current_members INTEGER DEFAULT 1,
        requirements TEXT NOT NULL,
        members TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'open'
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        party_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        responses TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (party_id) REFERENCES parties (id)
    )`);
    
    // Add username column if it doesn't exist (for existing databases)
    db.run(`ALTER TABLE applications ADD COLUMN username TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.log('Note: Could not add username column:', err.message);
        }
    });
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
});

// Utility functions
function generatePartyId() {
    return Math.random().toString(36).substring(2, 15);
}

function createPartyEmbed(party, members) {
    const embed = new EmbedBuilder()
        .setTitle(`🎮 ${party.title}`)
        .setColor(party.status === 'open' ? 0x00FF00 : 0xFF0000)
        .setDescription(party.description || 'No description provided')
        .addFields(
            { name: '👥 Members', value: `${party.current_members}/${party.max_members}`, inline: true },
            { name: '📋 Status', value: party.status === 'open' ? '🟢 Open' : '🔴 Closed', inline: true },
            { name: '👤 Party Leader', value: `<@${party.creator_id}>`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: `Party ID: ${party.id}` });

    // Add requirements
    const requirements = JSON.parse(party.requirements);
    if (requirements.length > 0) {
        const reqText = requirements.map(req => `• **${req.name}**: ${req.description || 'Any'}`).join('\n');
        embed.addFields({ name: '📝 Requirements', value: reqText });
    }

    // Add current members
    if (members.length > 1) {
        const memberList = members.slice(1).map(m => `<@${m}>`).join('\n');
        embed.addFields({ name: '👥 Current Members', value: memberList });
    }

    return embed;
}

function createPartyButtons(partyId, isCreator = false) {
    const row = new ActionRowBuilder();
    
    if (isCreator) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`manage_party_${partyId}`)
                .setLabel('Manage Party')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('⚙️'),
            new ButtonBuilder()
                .setCustomId(`close_party_${partyId}`)
                .setLabel('Close Party')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔒')
        );
    } else {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`join_party_${partyId}`)
                .setLabel('Apply to Join')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✋'),
            new ButtonBuilder()
                .setCustomId(`view_requirements_${partyId}`)
                .setLabel('View Requirements')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('📋')
        );
    }
    
    return row;
}

function createApplicationEmbed(application, party, applicantUser) {
    const embed = new EmbedBuilder()
        .setTitle(`🎮 New Application for: ${party.title}`)
        .setColor(0xFFAA00)
        .setDescription(`**${applicantUser.username}** wants to join your party`)
        .addFields(
            { name: '👤 Applicant', value: `<@${application.user_id}>`, inline: true },
            { name: '🆔 Party ID', value: party.id, inline: true },
            { name: '👥 Current Size', value: `${party.current_members}/${party.max_members}`, inline: true }
        )
        .setTimestamp()
        .setThumbnail(applicantUser.displayAvatarURL());

    // Add responses to requirements
    const requirements = JSON.parse(party.requirements);
    const responses = JSON.parse(application.responses);
    
    if (requirements.length > 0) {
        const responseText = requirements.map(req => {
            const response = responses[req.name] || 'No response';
            return `**${req.name}**: ${response}`;
        }).join('\n');
        embed.addFields({ name: '📝 Responses', value: responseText });
    }

    return embed;
}

function createApplicationButtons(applicationId) {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`approve_application_${applicationId}`)
                .setLabel('Accept')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`reject_application_${applicationId}`)
                .setLabel('Reject')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );
}

// Slash command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('create-party')
        .setDescription('Create a new party for matchmaking')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Title of your party')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('max-members')
                .setDescription('Maximum number of members (including you)')
                .setRequired(true)
                .setMinValue(2)
                .setMaxValue(20))
        .addStringOption(option =>
            option.setName('description')
                .setDescription('Description of your party')
                .setRequired(false)),
    
    new SlashCommandBuilder()
        .setName('manage-parties')
        .setDescription('Manage your parties - create, view, or leave parties'),

    new SlashCommandBuilder()
        .setName('pending-applications')
        .setDescription('View pending applications for your parties')
];

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    
    // Register slash commands
    try {
        console.log('Started refreshing application (/) commands.');
        await client.application.commands.set(commands);
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
    } else if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
    } else if (interaction.isStringSelectMenu()) {
        await handleSelectMenuInteraction(interaction);
    }
});

async function handleSlashCommand(interaction) {
    const { commandName } = interaction;

    if (commandName === 'create-party') {
        const title = interaction.options.getString('title');
        const maxMembers = interaction.options.getInteger('max-members');
        const description = interaction.options.getString('description');

        // Store party creation data and show requirements builder
        await showRequirementsBuilder(interaction, title, maxMembers, description, []);
    }

    if (commandName === 'manage-parties') {
        await showPartyManagementMenu(interaction);
    }

    if (commandName === 'pending-applications') {
        db.all(
            `SELECT a.*, p.title as party_title 
             FROM applications a 
             JOIN parties p ON a.party_id = p.id 
             WHERE p.creator_id = ? AND a.status = 'pending' 
             ORDER BY a.applied_at DESC`,
            [interaction.user.id],
            async (err, applications) => {
                if (err) {
                    await interaction.reply({ content: 'Error fetching applications.', ephemeral: true });
                    return;
                }

                if (applications.length === 0) {
                    await interaction.reply({ content: 'No pending applications for your parties.', ephemeral: true });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setTitle('Pending Applications')
                    .setColor(0xFFAA00)
                    .setDescription('Use the buttons in your DMs to approve/reject applications');

                applications.forEach(app => {
                    embed.addFields({
                        name: `${app.party_title}`,
                        value: `From: <@${app.user_id}>\nApplied: ${new Date(app.applied_at).toLocaleString()}\nID: ${app.id}`,
                        inline: true
                    });
                });

                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        );
    }
}

async function handleButtonInteraction(interaction) {
    const customId = interaction.customId;

    if (customId.startsWith('join_party_')) {
        const partyId = customId.replace('join_party_', '');
        await handlePartyApplication(interaction, partyId);
    }

    if (customId.startsWith('view_requirements_')) {
        const partyId = customId.replace('view_requirements_', '');
        
        db.get('SELECT * FROM parties WHERE id = ?', [partyId], async (err, party) => {
            if (err || !party) {
                await interaction.reply({ content: 'Party not found.', ephemeral: true });
                return;
            }

            const requirements = JSON.parse(party.requirements);
            const embed = new EmbedBuilder()
                .setTitle(`Requirements for: ${party.title}`)
                .setColor(0x0099FF);

            if (requirements.length === 0) {
                embed.setDescription('No specific requirements for this party.');
            } else {
                const reqText = requirements.map(req => `**${req.name}**: ${req.description || 'Any'}`).join('\n');
                embed.setDescription(reqText);
            }

            await interaction.reply({ embeds: [embed], ephemeral: true });
        });
    }

    if (customId.startsWith('approve_application_')) {
        const applicationId = customId.replace('approve_application_', '');
        await handleApplicationDecision(interaction, applicationId, 'approved');
    }

    if (customId.startsWith('reject_application_')) {
        const applicationId = customId.replace('reject_application_', '');
        await handleApplicationDecision(interaction, applicationId, 'rejected');
    }

    if (customId.startsWith('party_action_')) {
        const action = customId.replace('party_action_', '');
        
        if (action === 'create') {
            await interaction.reply({ 
                content: 'Use `/create-party` command to create a new party!', 
                ephemeral: true 
            });
        } else if (action === 'view') {
            await showAllPartiesView(interaction);
        } else if (action === 'leave') {
            await showLeavePartyMenu(interaction);
        } else if (action === 'message') {
            await showMessagePartyMenu(interaction);
        } else if (action === 'delete') {
            await showDeletePartyMenu(interaction);
        }
    }

    if (customId.startsWith('add_req_')) {
        const sessionId = customId.replace('add_req_', '');
        await showAddRequirementModal(interaction, sessionId);
    }

    if (customId.startsWith('remove_req_')) {
        const sessionId = customId.replace('remove_req_', '');
        await handleRemoveRequirement(interaction, sessionId);
    }

    if (customId.startsWith('create_party_')) {
        const sessionId = customId.replace('create_party_', '');
        await handleFinalPartyCreation(interaction, sessionId);
    }

    if (customId.startsWith('confirm_leave_')) {
        const partyId = customId.replace('confirm_leave_', '');
        
        db.get('SELECT * FROM parties WHERE id = ?', [partyId], async (err, party) => {
            if (err || !party) {
                await interaction.reply({ content: 'Party not found.', ephemeral: true });
                return;
            }

            const members = JSON.parse(party.members);
            if (!members.includes(interaction.user.id)) {
                await interaction.reply({ content: 'You are not a member of this party.', ephemeral: true });
                return;
            }

            // Remove user from party
            const updatedMembers = members.filter(id => id !== interaction.user.id);
            
            db.run(
                'UPDATE parties SET members = ?, current_members = ? WHERE id = ?',
                [JSON.stringify(updatedMembers), updatedMembers.length, partyId],
                async function(err) {
                    if (err) {
                        await interaction.reply({ content: 'Error leaving party.', ephemeral: true });
                        return;
                    }

                    await interaction.reply({ content: `✅ You have left the party "${party.title}".`, ephemeral: true });
                    
                    // Notify party creator
                    try {
                        const creator = await client.users.fetch(party.creator_id);
                        await creator.send(`${interaction.user.tag} has left your party "${party.title}".`);
                    } catch (error) {
                        console.log('Could not notify party creator');
                    }

                    // Update party message if it exists
                    await updatePartyMessage({ ...party, members: JSON.stringify(updatedMembers), current_members: updatedMembers.length });
                }
            );
        });
    }

    if (customId.startsWith('confirm_delete_')) {
        const partyId = customId.replace('confirm_delete_', '');
        
        db.get('SELECT * FROM parties WHERE id = ? AND creator_id = ?', [partyId, interaction.user.id], async (err, party) => {
            if (err || !party) {
                await interaction.reply({ content: 'Party not found or you are not the creator.', ephemeral: true });
                return;
            }

            // Get all members to notify them
            const members = JSON.parse(party.members);
            const otherMembers = members.filter(id => id !== interaction.user.id);

            // Delete the party (mark as deleted)
            db.run(
                'UPDATE parties SET status = "deleted" WHERE id = ?',
                [partyId],
                async function(err) {
                    if (err) {
                        await interaction.reply({ content: 'Error deleting party.', ephemeral: true });
                        return;
                    }

                    await interaction.reply({ content: `✅ Successfully deleted party "${party.title}". All members have been notified.`, ephemeral: true });

                    // Notify all other members that the party was deleted
                    for (const memberId of otherMembers) {
                        try {
                            const member = await client.users.fetch(memberId);
                            await member.send(`🗑️ The party "${party.title}" has been deleted by the party leader. You have been removed from the party.`);
                        } catch (error) {
                            console.log(`Could not notify member ${memberId}`);
                        }
                    }

                    // Update the original party message to show it's deleted
                    if (party.message_id) {
                        try {
                            const channel = await client.channels.fetch(party.channel_id);
                            const message = await channel.messages.fetch(party.message_id);
                            
                            const deletedEmbed = new EmbedBuilder()
                                .setTitle(`🗑️ ${party.title} [DELETED]`)
                                .setColor(0xFF0000)
                                .setDescription('This party has been deleted by the party leader.')
                                .setTimestamp();

                            await message.edit({ embeds: [deletedEmbed], components: [] });
                        } catch (error) {
                            console.log('Could not update party message:', error.message);
                        }
                    }
                }
            );
        });
    }

    if (customId.startsWith('confirm_message_')) {
        const partyId = customId.replace('confirm_message_', '');
        await handleCreatePartyThread(interaction, partyId);
    }

    if (customId === 'cancel_action') {
        await interaction.reply({ 
            content: '❌ Action cancelled.', 
            ephemeral: true 
        });
    }

    if (customId.startsWith('manage_party_')) {
        const partyId = customId.replace('manage_party_', '');
        
        db.get('SELECT * FROM parties WHERE id = ? AND creator_id = ?', [partyId, interaction.user.id], async (err, party) => {
            if (err || !party) {
                await interaction.reply({ content: 'Party not found or you are not the creator.', ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`Managing: ${party.title}`)
                .setColor(0x0099FF)
                .setDescription('Choose an action:');

            const buttons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`kick_member_${partyId}`)
                        .setLabel('Kick Member')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('👢'),
                    new ButtonBuilder()
                        .setCustomId(`edit_requirements_${partyId}`)
                        .setLabel('Edit Requirements')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
        });
    }

    if (customId.startsWith('close_party_')) {
        const partyId = customId.replace('close_party_', '');
        
        db.run(
            'UPDATE parties SET status = "closed" WHERE id = ? AND creator_id = ?',
            [partyId, interaction.user.id],
            async function(err) {
                if (err || this.changes === 0) {
                    await interaction.reply({ content: 'Error closing party or you are not the creator.', ephemeral: true });
                    return;
                }

                await interaction.reply({ content: 'Party has been closed.', ephemeral: true });
                
                // Update the party message
                db.get('SELECT * FROM parties WHERE id = ?', [partyId], async (err, party) => {
                    if (!err && party) {
                        await updatePartyMessage(party);
                    }
                });
            }
        );
    }
}

async function handleSelectMenuInteraction(interaction) {
    const customId = interaction.customId;

    if (customId === 'leave_party_select') {
        const selectedPartyId = interaction.values[0];
        await handleLeavePartySelection(interaction, selectedPartyId);
    }

    if (customId === 'delete_party_select') {
        const selectedPartyId = interaction.values[0];
        await handleDeletePartySelection(interaction, selectedPartyId);
    }

    if (customId === 'message_party_select') {
        const selectedPartyId = interaction.values[0];
        await handleMessagePartySelection(interaction, selectedPartyId);
    }
}

async function handleModalSubmit(interaction) {
    const customId = interaction.customId;

    if (customId.startsWith('add_req_modal_')) {
        const sessionId = customId.replace('add_req_modal_', '');
        
        const requirementName = interaction.fields.getTextInputValue('requirement_name');
        const requirementDescription = interaction.fields.getTextInputValue('requirement_description');
        
        if (!requirementName.trim()) {
            await interaction.reply({ content: 'Requirement name cannot be empty.', ephemeral: true });
            return;
        }

        // Get party data from session
        const partyData = partyCreationSessions.get(sessionId);
        if (!partyData || partyData.userId !== interaction.user.id) {
            await interaction.reply({ content: 'Session expired. Please start over with `/create-party`.', ephemeral: true });
            return;
        }

        // Add new requirement
        partyData.requirements.push({
            name: requirementName.trim(),
            description: requirementDescription.trim() || ''
        });

        // Update session
        partyCreationSessions.set(sessionId, partyData);

        // Show updated requirements builder
        await showRequirementsBuilder(interaction, partyData.title, partyData.maxMembers, partyData.description, partyData.requirements);
    }

    if (customId.startsWith('apply_party_')) {
        const partyId = customId.replace('apply_party_', '');
        
        try {
            db.get('SELECT * FROM parties WHERE id = ?', [partyId], async (err, party) => {
                if (err || !party || party.status !== 'open') {
                    await interaction.reply({ content: 'This party is no longer available.', ephemeral: true });
                    return;
                }

                const requirements = JSON.parse(party.requirements);
                const responses = {};

                // Collect responses
                try {
                    requirements.forEach(req => {
                        const value = interaction.fields.getTextInputValue(req.name);
                        responses[req.name] = value;
                    });
                } catch (fieldError) {
                    console.log('Error collecting field responses:', fieldError);
                    await interaction.reply({ content: 'Error processing your application. Please try again.', ephemeral: true });
                    return;
                }

                // Check if user already applied
                db.get(
                    'SELECT * FROM applications WHERE party_id = ? AND user_id = ? AND status = "pending"',
                    [partyId, interaction.user.id],
                    async (err, existingApp) => {
                        if (existingApp) {
                            await interaction.reply({ content: 'You already have a pending application for this party.', ephemeral: true });
                            return;
                        }

                        // Create application
                        db.run(
                            'INSERT INTO applications (party_id, user_id, username, responses) VALUES (?, ?, ?, ?)',
                            [partyId, interaction.user.id, interaction.user.username, JSON.stringify(responses)],
                            async function(err) {
                                if (err) {
                                    console.log('Database error creating application:', err);
                                    await interaction.reply({ content: 'Error submitting application.', ephemeral: true });
                                    return;
                                }

                                const applicationId = this.lastID;
                                await interaction.reply({ content: `Application submitted for "${party.title}"! The party leader will review your application.`, ephemeral: true });

                                // Send DM to party creator
                                try {
                                    const creator = await client.users.fetch(party.creator_id);
                                    const applicant = await client.users.fetch(interaction.user.id);
                                    
                                    const application = {
                                        id: applicationId,
                                        party_id: partyId,
                                        user_id: interaction.user.id,
                                        username: interaction.user.username,
                                        responses: JSON.stringify(responses)
                                    };

                                    const embed = createApplicationEmbed(application, party, applicant);
                                    const buttons = createApplicationButtons(applicationId);

                                    await creator.send({ 
                                        embeds: [embed], 
                                        components: [buttons] 
                                    });
                                } catch (error) {
                                    console.log('Could not send DM to party creator:', error.message);
                                }
                            }
                        );
                    }
                );
            });
        } catch (error) {
            console.log('Error in apply_party modal handling:', error);
            await interaction.reply({ content: 'Error processing application. Please try again.', ephemeral: true });
        }
    }
}

async function handlePartyApplication(interaction, partyId) {
    db.get('SELECT * FROM parties WHERE id = ?', [partyId], async (err, party) => {
        if (err || !party || party.status !== 'open') {
            await interaction.reply({ content: 'This party is no longer available.', ephemeral: true });
            return;
        }

        const members = JSON.parse(party.members);
        if (members.includes(interaction.user.id)) {
            await interaction.reply({ content: 'You are already a member of this party.', ephemeral: true });
            return;
        }

        if (party.current_members >= party.max_members) {
            await interaction.reply({ content: 'This party is full.', ephemeral: true });
            return;
        }

        // Check if user already has a pending application
        db.get(
            'SELECT * FROM applications WHERE party_id = ? AND user_id = ? AND status = "pending"',
            [partyId, interaction.user.id],
            async (err, existingApp) => {
                if (existingApp) {
                    await interaction.reply({ content: 'You already have a pending application for this party.', ephemeral: true });
                    return;
                }

                const requirements = JSON.parse(party.requirements);
                
                if (requirements.length === 0) {
                    // No requirements, add directly
                    await addUserToParty(interaction, party, {});
                } else {
                    // Show application modal
                    await showApplicationModal(interaction, party);
                }
            }
        );
    });
}

async function handleApplicationDecision(interaction, applicationId, decision) {
    db.get(
        `SELECT a.*, p.* FROM applications a 
         JOIN parties p ON a.party_id = p.id 
         WHERE a.id = ? AND p.creator_id = ?`,
        [applicationId, interaction.user.id],
        async (err, result) => {
            if (err || !result) {
                await interaction.reply({ content: 'Application not found or you are not the party creator.', ephemeral: true });
                return;
            }

            if (decision === 'approved') {
                // Check if party is still open and has space
                if (result.status !== 'open') {
                    await interaction.reply({ content: 'This party is no longer open.', ephemeral: true });
                    return;
                }

                if (result.current_members >= result.max_members) {
                    await interaction.reply({ content: 'This party is now full.', ephemeral: true });
                    return;
                }

                // Add user to party
                const members = JSON.parse(result.members);
                members.push(result.user_id);

                db.run(
                    'UPDATE parties SET members = ?, current_members = ? WHERE id = ?',
                    [JSON.stringify(members), members.length, result.party_id],
                    async function(err) {
                        if (err) {
                            await interaction.reply({ content: 'Error adding user to party.', ephemeral: true });
                            return;
                        }

                        // Update application status
                        db.run('UPDATE applications SET status = ? WHERE id = ?', [decision, applicationId]);

                        await interaction.reply({ content: `✅ Approved ${result.username} for "${result.title}"!`, ephemeral: true });

                        // Notify applicant
                        try {
                            const applicant = await client.users.fetch(result.user_id);
                            await applicant.send(`🎉 Your application to join "${result.title}" has been **approved**! You're now part of the party.`);
                        } catch (error) {
                            console.log('Could not notify applicant');
                        }

                        // Update party message
                        const updatedParty = { ...result, members: JSON.stringify(members), current_members: members.length };
                        await updatePartyMessage(updatedParty);
                    }
                );
            } else {
                // Reject application
                db.run('UPDATE applications SET status = ? WHERE id = ?', [decision, applicationId], async function(err) {
                    if (err) {
                        await interaction.reply({ content: 'Error updating application.', ephemeral: true });
                        return;
                    }

                    await interaction.reply({ content: `❌ Rejected ${result.username}'s application for "${result.title}".`, ephemeral: true });

                    // Notify applicant
                    try {
                        const applicant = await client.users.fetch(result.user_id);
                        await applicant.send(`Your application to join "${result.title}" was not accepted this time. Keep looking for other parties!`);
                    } catch (error) {
                        console.log('Could not notify applicant');
                    }
                });
            }
        }
    );
}

async function showApplicationModal(interaction, party) {
    const requirements = JSON.parse(party.requirements);
    
    const modal = new ModalBuilder()
        .setCustomId(`apply_party_${party.id}`)
        .setTitle(`Apply to: ${party.title}`);

    // Add up to 5 requirements (Discord modal limit)
    const components = [];
    for (let i = 0; i < Math.min(requirements.length, 5); i++) {
        const req = requirements[i];
        const input = new TextInputBuilder()
            .setCustomId(req.name)
            .setLabel(req.name)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(req.description || 'Enter your response')
            .setRequired(true);
        
        components.push(new ActionRowBuilder().addComponents(input));
    }

    modal.addComponents(...components);
    await interaction.showModal(modal);
}

async function addUserToParty(interaction, party, responses) {
    const members = JSON.parse(party.members);
    
    if (members.includes(interaction.user.id)) {
        await interaction.reply({ content: 'You are already a member of this party.', ephemeral: true });
        return;
    }

    if (party.current_members >= party.max_members) {
        await interaction.reply({ content: 'This party is full.', ephemeral: true });
        return;
    }

    // Add user to party
    members.push(interaction.user.id);
    
    db.run(
        'UPDATE parties SET members = ?, current_members = ? WHERE id = ?',
        [JSON.stringify(members), members.length, party.id],
        async function(err) {
            if (err) {
                await interaction.reply({ content: 'Error joining party.', ephemeral: true });
                return;
            }

            await interaction.reply({ content: `Successfully joined "${party.title}"!`, ephemeral: true });
            
            // Notify party creator
            try {
                const creator = await client.users.fetch(party.creator_id);
                await creator.send(`${interaction.user.tag} has joined your party "${party.title}".`);
            } catch (error) {
                console.log('Could not notify party creator');
            }

            // Update party message
            await updatePartyMessage({ ...party, members: JSON.stringify(members), current_members: members.length });
        }
    );
}

async function showRequirementsBuilder(interaction, title, maxMembers, description, requirements) {
    // Generate session ID and store party data
    const sessionId = generateSessionId();
    partyCreationSessions.set(sessionId, {
        title,
        maxMembers,
        description,
        requirements,
        userId: interaction.user.id,
        timestamp: Date.now()
    });

    const embed = new EmbedBuilder()
        .setTitle('🛠️ Building Your Party')
        .setColor(0x0099FF)
        .addFields(
            { name: '🎮 Party Title', value: title, inline: true },
            { name: '👥 Max Members', value: maxMembers.toString(), inline: true },
            { name: '📋 Status', value: 'Setting up requirements', inline: true }
        );

    if (description) {
        embed.addFields({ name: '📝 Description', value: description, inline: false });
    }

    // Show current requirements
    if (requirements.length > 0) {
        const reqText = requirements.map((req, index) => {
            return `**${index + 1}.** ${req.name}${req.description ? ` - ${req.description}` : ''}`;
        }).join('\n');
        embed.addFields({ name: `📋 Requirements (${requirements.length})`, value: reqText, inline: false });
    } else {
        embed.addFields({ name: '📋 Requirements', value: 'No requirements added yet', inline: false });
    }

    const buttons = new ActionRowBuilder();
    
    // Add requirement button
    buttons.addComponents(
        new ButtonBuilder()
            .setCustomId(`add_req_${sessionId}`)
            .setLabel('Add Requirement')
            .setStyle(ButtonStyle.Success)
            .setEmoji('➕')
    );

    // Remove requirement button (only if there are requirements)
    if (requirements.length > 0) {
        buttons.addComponents(
            new ButtonBuilder()
                .setCustomId(`remove_req_${sessionId}`)
                .setLabel(`Remove Last Requirement`)
                .setStyle(ButtonStyle.Danger)
                .setEmoji('➖')
        );
    }

    // Create party button
    buttons.addComponents(
        new ButtonBuilder()
            .setCustomId(`create_party_${sessionId}`)
            .setLabel(requirements.length > 0 ? `Create Party (${requirements.length} requirements)` : 'Create Party (No requirements)')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🎉')
    );

    const method = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
    await interaction[method]({
        embeds: [embed],
        components: [buttons],
        ephemeral: true
    });
}

async function showAddRequirementModal(interaction, sessionId) {
    const modal = new ModalBuilder()
        .setCustomId(`add_req_modal_${sessionId}`)
        .setTitle('Add Party Requirement');

    const nameInput = new TextInputBuilder()
        .setCustomId('requirement_name')
        .setLabel('Requirement Name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., Rank, Timezone, Agent, Level')
        .setMaxLength(50)
        .setRequired(true);

    const descriptionInput = new TextInputBuilder()
        .setCustomId('requirement_description')
        .setLabel('Requirement Description (Optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('e.g., Diamond or higher, EST preferred, Must play support, 200+')
        .setMaxLength(200)
        .setRequired(false);

    const nameRow = new ActionRowBuilder().addComponents(nameInput);
    const descRow = new ActionRowBuilder().addComponents(descriptionInput);
    
    modal.addComponents(nameRow, descRow);
    await interaction.showModal(modal);
}

async function handleRemoveRequirement(interaction, sessionId) {
    const partyData = partyCreationSessions.get(sessionId);
    if (!partyData || partyData.userId !== interaction.user.id) {
        await interaction.reply({ content: 'Session expired. Please start over with `/create-party`.', ephemeral: true });
        return;
    }
    
    // Remove the last requirement
    if (partyData.requirements.length > 0) {
        partyData.requirements.pop();
        partyCreationSessions.set(sessionId, partyData);
    }

    // Show updated requirements builder
    await showRequirementsBuilder(interaction, partyData.title, partyData.maxMembers, partyData.description, partyData.requirements);
}

async function handleFinalPartyCreation(interaction, sessionId) {
    const partyData = partyCreationSessions.get(sessionId);
    if (!partyData || partyData.userId !== interaction.user.id) {
        await interaction.reply({ content: 'Session expired. Please start over with `/create-party`.', ephemeral: true });
        return;
    }
    
    // Defer the reply first since party creation might take a moment
    await interaction.deferReply({ ephemeral: true });
    
    // Clean up session
    partyCreationSessions.delete(sessionId);
    
    // Create the party
    const partyId = generatePartyId();
    const members = [interaction.user.id];

    db.run(
        'INSERT INTO parties (id, creator_id, guild_id, channel_id, title, description, max_members, requirements, members) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [partyId, interaction.user.id, interaction.guild.id, interaction.channel.id, partyData.title, partyData.description, partyData.maxMembers, JSON.stringify(partyData.requirements), JSON.stringify(members)],
        async function(err) {
            if (err) {
                await interaction.editReply({ content: 'Error creating party.' });
                return;
            }

            const party = {
                id: partyId,
                creator_id: interaction.user.id,
                guild_id: interaction.guild.id,
                channel_id: interaction.channel.id,
                title: partyData.title,
                description: partyData.description,
                max_members: partyData.maxMembers,
                current_members: 1,
                requirements: JSON.stringify(partyData.requirements),
                members: JSON.stringify(members),
                status: 'open'
            };

            const embed = createPartyEmbed(party, members);
            const buttons = createPartyButtons(partyId);

            // Update the interaction to show success
            await interaction.editReply({
                content: '✅ Party created successfully! Check the channel for your party post.'
            });

            // Create the actual party post in the channel
            const channel = interaction.channel;
            const message = await channel.send({ 
                embeds: [embed], 
                components: [buttons]
            });

            // Update party with message ID
            db.run('UPDATE parties SET message_id = ? WHERE id = ?', [message.id, partyId]);
        }
    );
}

async function showPartyManagementMenu(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('🎮 Party Management')
        .setColor(0x0099FF)
        .setDescription('Choose what you\'d like to do with your parties:')
        .addFields(
            { name: '🆕 Create Party', value: 'Start a new party and invite others', inline: true },
            { name: '👀 View Parties', value: 'See all your parties (created & joined)', inline: true },
            { name: '🚪 Leave Party', value: 'Leave a party you\'ve joined', inline: true },
            { name: '💬 Message Party', value: 'Create a thread and message party members', inline: true },
            { name: '🗑️ Delete Party', value: 'Delete a party you created', inline: true }
        );

    const buttons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('party_action_create')
                .setLabel('Create Party')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🆕'),
            new ButtonBuilder()
                .setCustomId('party_action_view')
                .setLabel('View Parties')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('👀'),
            new ButtonBuilder()
                .setCustomId('party_action_leave')
                .setLabel('Leave Party')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🚪'),
            new ButtonBuilder()
                .setCustomId('party_action_message')
                .setLabel('Message Party')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('💬')
        );

    const buttons2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('party_action_delete')
                .setLabel('Delete Party')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
        );

    await interaction.reply({
        embeds: [embed],
        components: [buttons, buttons2],
        ephemeral: true
    });
}

async function showAllPartiesView(interaction) {
    // Get parties user created
    db.all(
        'SELECT * FROM parties WHERE creator_id = ? AND status = "open" ORDER BY created_at DESC',
        [interaction.user.id],
        async (err, createdParties) => {
            if (err) {
                await interaction.reply({ content: 'Error fetching your parties.', ephemeral: true });
                return;
            }

            // Get parties user joined
            db.all(
                'SELECT * FROM parties WHERE status = "open" AND members LIKE ? ORDER BY created_at DESC',
                [`%"${interaction.user.id}"%`],
                async (err, allParties) => {
                    if (err) {
                        await interaction.reply({ content: 'Error fetching joined parties.', ephemeral: true });
                        return;
                    }

                    // Filter out parties where user is just a member (not creator)
                    const joinedParties = allParties.filter(party => {
                        const members = JSON.parse(party.members);
                        return members.includes(interaction.user.id) && party.creator_id !== interaction.user.id;
                    });

                    if (createdParties.length === 0 && joinedParties.length === 0) {
                        await interaction.reply({ content: 'You are not in any active parties.', ephemeral: true });
                        return;
                    }

                    // Create comprehensive party view (NO buttons, just display)
                    await showPartiesReadOnly(interaction, createdParties, joinedParties);
                }
            );
        }
    );
}

async function showLeavePartyMenu(interaction) {
    // Get parties user joined (not created)
    db.all(
        'SELECT * FROM parties WHERE status = "open" AND members LIKE ? ORDER BY created_at DESC',
        [`%"${interaction.user.id}"%`],
        async (err, allParties) => {
            if (err) {
                await interaction.reply({ content: 'Error fetching parties.', ephemeral: true });
                return;
            }

            // Filter to only parties where user is a member but not creator
            const joinedParties = allParties.filter(party => {
                const members = JSON.parse(party.members);
                return members.includes(interaction.user.id) && party.creator_id !== interaction.user.id;
            });

            if (joinedParties.length === 0) {
                await interaction.reply({ content: 'You haven\'t joined any parties that you can leave.', ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('🚪 Leave a Party')
                .setColor(0xFF6B35)
                .setDescription('Select a party to leave:');

            // Create select menu with joined parties
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('leave_party_select')
                .setPlaceholder('Choose a party to leave...')
                .addOptions(
                    joinedParties.slice(0, 25).map(party => ({
                        label: party.title,
                        description: `${party.current_members}/${party.max_members} members`,
                        value: party.id
                    }))
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.reply({
                embeds: [embed],
                components: [row],
                ephemeral: true
            });
        }
    );
}

async function showDeletePartyMenu(interaction) {
    // Get parties user created
    db.all(
        'SELECT * FROM parties WHERE creator_id = ? AND status = "open" ORDER BY created_at DESC',
        [interaction.user.id],
        async (err, createdParties) => {
            if (err) {
                await interaction.reply({ content: 'Error fetching your parties.', ephemeral: true });
                return;
            }

            if (createdParties.length === 0) {
                await interaction.reply({ content: 'You haven\'t created any parties to delete.', ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('🗑️ Delete a Party')
                .setColor(0xFF0000)
                .setDescription('⚠️ **Warning:** This will permanently delete the party and remove all members.\n\nSelect a party to delete:');

            // Create select menu with created parties
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('delete_party_select')
                .setPlaceholder('Choose a party to delete...')
                .addOptions(
                    createdParties.slice(0, 25).map(party => ({
                        label: party.title,
                        description: `${party.current_members}/${party.max_members} members`,
                        value: party.id
                    }))
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.reply({
                embeds: [embed],
                components: [row],
                ephemeral: true
            });
        }
    );
}

async function showMessagePartyMenu(interaction) {
    // Get parties user created
    db.all(
        'SELECT * FROM parties WHERE creator_id = ? AND status = "open" ORDER BY created_at DESC',
        [interaction.user.id],
        async (err, createdParties) => {
            if (err) {
                await interaction.reply({ content: 'Error fetching your parties.', ephemeral: true });
                return;
            }

            if (createdParties.length === 0) {
                await interaction.reply({ content: 'You haven\'t created any parties to message.', ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('💬 Message a Party')
                .setColor(0x5865F2)
                .setDescription('Select a party to create a thread and message all members:');

            // Create select menu with created parties
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('message_party_select')
                .setPlaceholder('Choose a party to message...')
                .addOptions(
                    createdParties.slice(0, 25).map(party => ({
                        label: party.title,
                        description: `${party.current_members}/${party.max_members} members`,
                        value: party.id
                    }))
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.reply({
                embeds: [embed],
                components: [row],
                ephemeral: true
            });
        }
    );
}

async function handleLeavePartySelection(interaction, partyId) {
    db.get('SELECT * FROM parties WHERE id = ?', [partyId], async (err, party) => {
        if (err || !party) {
            await interaction.reply({ content: 'Party not found.', ephemeral: true });
            return;
        }

        const members = JSON.parse(party.members);
        if (!members.includes(interaction.user.id)) {
            await interaction.reply({ content: 'You are not a member of this party.', ephemeral: true });
            return;
        }

        if (party.creator_id === interaction.user.id) {
            await interaction.reply({ content: 'You cannot leave your own party. Use the delete option instead.', ephemeral: true });
            return;
        }

        // Show party details with confirmation button
        const memberMentions = members.map(id => `<@${id}>`);

        const partyEmbed = new EmbedBuilder()
            .setTitle(`🎮 ${party.title}`)
            .setColor(0x4169E1)
            .setDescription('**Are you sure you want to leave this party?**')
            .addFields(
                { name: '👑 Party Leader', value: `<@${party.creator_id}>`, inline: true },
                { name: '👥 Members', value: `${party.current_members}/${party.max_members}`, inline: true },
                { name: '📋 Status', value: '🟢 Open', inline: true }
            )
            .setTimestamp();

        if (memberMentions.length > 0) {
            partyEmbed.addFields({
                name: '👤 All Members',
                value: memberMentions.join(', '),
                inline: false
            });
        }

        if (party.description) {
            partyEmbed.addFields({
                name: '📝 Description',
                value: party.description,
                inline: false
            });
        }

        const confirmButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_leave_${party.id}`)
                    .setLabel(`Yes, Leave "${party.title}"`)
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🚪'),
                new ButtonBuilder()
                    .setCustomId('cancel_action')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('❌')
            );

        await interaction.reply({
            embeds: [partyEmbed],
            components: [confirmButton],
            ephemeral: true
        });
    });
}

async function handleDeletePartySelection(interaction, partyId) {
    db.get('SELECT * FROM parties WHERE id = ? AND creator_id = ?', [partyId, interaction.user.id], async (err, party) => {
        if (err || !party) {
            await interaction.reply({ content: 'Party not found or you are not the creator.', ephemeral: true });
            return;
        }

        // Show party details with confirmation button
        const members = JSON.parse(party.members);
        const memberMentions = members.map(id => `<@${id}>`);

        const partyEmbed = new EmbedBuilder()
            .setTitle(`🎮 ${party.title}`)
            .setColor(0xFF0000)
            .setDescription('⚠️ **Are you sure you want to delete this party?**\n\nThis will permanently remove the party and notify all members.')
            .addFields(
                { name: '👥 Members', value: `${party.current_members}/${party.max_members}`, inline: true },
                { name: '📋 Status', value: '🟢 Open', inline: true },
                { name: '👤 You are the leader', value: 'This party will be deleted', inline: true }
            )
            .setTimestamp();

        if (memberMentions.length > 0) {
            partyEmbed.addFields({
                name: '👤 All Members (will be removed)',
                value: memberMentions.join(', '),
                inline: false
            });
        }

        if (party.description) {
            partyEmbed.addFields({
                name: '📝 Description',
                value: party.description,
                inline: false
            });
        }

        const confirmButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_delete_${party.id}`)
                    .setLabel(`Yes, Delete "${party.title}"`)
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🗑️'),
                new ButtonBuilder()
                    .setCustomId('cancel_action')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('❌')
            );

        await interaction.reply({
            embeds: [partyEmbed],
            components: [confirmButton],
            ephemeral: true
        });
    });
}

async function handleMessagePartySelection(interaction, partyId) {
    db.get('SELECT * FROM parties WHERE id = ? AND creator_id = ?', [partyId, interaction.user.id], async (err, party) => {
        if (err || !party) {
            await interaction.reply({ content: 'Party not found or you are not the creator.', ephemeral: true });
            return;
        }

        // Show party details with message confirmation button
        const members = JSON.parse(party.members);
        const memberMentions = members.map(id => `<@${id}>`);

        const partyEmbed = new EmbedBuilder()
            .setTitle(`🎮 ${party.title}`)
            .setColor(0x5865F2)
            .setDescription('**Ready to message this party?**\n\nThis will create a thread and tag all members.')
            .addFields(
                { name: '👥 Members', value: `${party.current_members}/${party.max_members}`, inline: true },
                { name: '📋 Status', value: '🟢 Open', inline: true },
                { name: '👤 You are the leader', value: 'Creating thread for party', inline: true }
            )
            .setTimestamp();

        if (memberMentions.length > 0) {
            partyEmbed.addFields({
                name: '👤 Members to be tagged',
                value: memberMentions.join(', '),
                inline: false
            });
        }

        if (party.description) {
            partyEmbed.addFields({
                name: '📝 Description',
                value: party.description,
                inline: false
            });
        }

        const confirmButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_message_${party.id}`)
                    .setLabel(`Create Thread for "${party.title}"`)
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('💬'),
                new ButtonBuilder()
                    .setCustomId('cancel_action')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('❌')
            );

        await interaction.reply({
            embeds: [partyEmbed],
            components: [confirmButton],
            ephemeral: true
        });
    });
}

async function handleCreatePartyThread(interaction, partyId) {
    db.get('SELECT * FROM parties WHERE id = ? AND creator_id = ?', [partyId, interaction.user.id], async (err, party) => {
        if (err || !party) {
            await interaction.reply({ content: 'Party not found or you are not the creator.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const members = JSON.parse(party.members);
            const memberMentions = members.map(id => `<@${id}>`).join(' ');

            // Create the initial message that will start the thread
            const embed = new EmbedBuilder()
                .setTitle(`🎮 ${party.title} - Party Discussion`)
                .setColor(0x5865F2)
                .setDescription(`Party leader <@${party.creator_id}> has started a discussion for this party!`)
                .addFields(
                    { name: '👥 Party Members', value: memberMentions, inline: false }
                )
                .setTimestamp();

            if (party.description) {
                embed.addFields({
                    name: '📝 Party Description',
                    value: party.description,
                    inline: false
                });
            }

            // Send the message first
            const channel = interaction.channel;
            const message = await channel.send({
                content: `🧵 **Party Discussion Started!**\n\n${memberMentions}`,
                embeds: [embed]
            });

            // Create a thread from this message
            const thread = await message.startThread({
                name: `🎮 ${party.title} Discussion`,
                autoArchiveDuration: 1440, // 24 hours
                reason: `Party discussion thread created by ${interaction.user.tag}`
            });

            // Send a welcome message in the thread
            await thread.send({
                content: `Welcome to the party discussion! 🎉\n\n${memberMentions}\n\nUse this thread to coordinate your gaming session.`
            });

            await interaction.editReply({
                content: `✅ Successfully created thread "${thread.name}" and tagged all ${members.length} party members!`
            });

        } catch (error) {
            console.log('Error creating party thread:', error);
            await interaction.editReply({
                content: '❌ Error creating thread. Make sure the bot has permission to create threads in this channel.'
            });
        }
    });
}

async function showPartiesReadOnly(interaction, createdParties, joinedParties) {
    const embeds = [];

    // Created Parties Section (show ALL with no buttons)
    if (createdParties.length > 0) {
        const headerEmbed = new EmbedBuilder()
            .setTitle('🎯 Parties You Created')
            .setColor(0x00FF00)
            .setDescription(`You are the party leader for ${createdParties.length} parties`);
        embeds.push(headerEmbed);

        for (const party of createdParties) {
            const members = JSON.parse(party.members);
            const memberMentions = members.map(id => `<@${id}>`);

            const partyEmbed = new EmbedBuilder()
                .setTitle(`🎮 ${party.title}`)
                .setColor(0x32CD32)
                .addFields(
                    { name: '👥 Members', value: `${party.current_members}/${party.max_members}`, inline: true },
                    { name: '📋 Status', value: '🟢 Open', inline: true }
                )
                .setTimestamp();

            if (memberMentions.length > 0) {
                partyEmbed.addFields({
                    name: '👤 All Members',
                    value: memberMentions.join(', '),
                    inline: false
                });
            }

            if (party.description) {
                partyEmbed.addFields({
                    name: '📝 Description',
                    value: party.description,
                    inline: false
                });
            }

            embeds.push(partyEmbed);
        }
    }

    // Joined Parties Section (show ALL with no buttons)
    if (joinedParties.length > 0) {
        const headerEmbed = new EmbedBuilder()
            .setTitle('👥 Parties You Joined')
            .setColor(0x0099FF)
            .setDescription(`You are a member of ${joinedParties.length} parties`);
        embeds.push(headerEmbed);

        for (const party of joinedParties) {
            const members = JSON.parse(party.members);
            const memberMentions = members.map(id => `<@${id}>`);

            const partyEmbed = new EmbedBuilder()
                .setTitle(`🎮 ${party.title}`)
                .setColor(0x4169E1)
                .addFields(
                    { name: '👑 Party Leader', value: `<@${party.creator_id}>`, inline: true },
                    { name: '👥 Members', value: `${party.current_members}/${party.max_members}`, inline: true }
                )
                .setTimestamp();

            if (memberMentions.length > 0) {
                partyEmbed.addFields({
                    name: '👤 All Members',
                    value: memberMentions.join(', '),
                    inline: false
                });
            }

            if (party.description) {
                partyEmbed.addFields({
                    name: '📝 Description',
                    value: party.description,
                    inline: false
                });
            }

            embeds.push(partyEmbed);
        }
    }

    // Send read-only view (no components at all)
    await interaction.reply({ 
        embeds: embeds, 
        ephemeral: true 
    });
}

async function updatePartyMessage(party) {
    if (!party.message_id) return;

    try {
        const channel = await client.channels.fetch(party.channel_id);
        const message = await channel.messages.fetch(party.message_id);
        
        const members = JSON.parse(party.members);
        const embed = createPartyEmbed(party, members);
        const buttons = createPartyButtons(party.id, false);

        await message.edit({ embeds: [embed], components: party.status === 'open' ? [buttons] : [] });
    } catch (error) {
        console.log('Could not update party message:', error.message);
    }
}

/ Login with your bot token
client.login('MTM5Nzc4MTMwNjU2OTM5NjI2NA.GBQZxU.9ov8YDRgTxOd_yyp0nFKMt-BYy9qhscJqBOwdU');

